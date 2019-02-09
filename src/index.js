// @flow

import Debug from 'debug'
import Bot from 'keybase-bot'
import { Client as ElasticClient } from 'elasticsearch'
import { warn, err, fatal } from './log'
import { config } from './config'

import type {
  ChatConversation,
  TextContent,
  ChatChannel,
  MessageSummary,
  Pagination,
  ChatReadOptions,
  EditContent,
  DeleteContent
} from 'keybase-bot/lib/chat-client/types'

const debug = Debug('keybase-export')

const bot = new Bot()

const elasticClient = new ElasticClient(config.elasticsearch.config)

const INIT_OPTIONS = {
  disableTyping: true
}

async function init () {
  const initConfig = config.init
  if (initConfig.type === 'initFromRunningService') {
    debug('initFromRunningService start')
    await bot.initFromRunningService()
    debug('initFromRunningService end')
  } else {
    debug('init start')
    await bot.init(initConfig.username, initConfig.paperkey, INIT_OPTIONS)
    debug('init end')
  }
}

function findChat (chats: ChatConversation[], query: string): ?ChatConversation {
  // Query string examples:
  //   - you,them
  //   - $id$0000f0b5c2c2211c8d67ed15e75e656c7862d086e9245420892a7de62cd9ec58

  const specialMode = query.match(/^\$(.+?)\$(.+)/)

  if (!specialMode) {
    // Search by channel name (like `you,them`)
    return chats.find(chat => chat.channel.name === query)
  }

  const [, mode, value] = specialMode

  switch (mode) {
    case 'id':
      // Search by chat id
      return chats.find(chat => chat.id === value)
    default:
      warn(`Unknown mode '${mode}'`)
      return undefined
  }
}

const indexPattern = 'keybase_$channelname$'
function genEsIndexName (chat: ChatConversation) {
  return indexPattern
    .replace('$channelname$', chat.channel.name)
}

export type ReadResult = {|
  messages: MessageSummary[],
  pagination: Pagination,
|}
// Temporary workaround. See PR: https://github.com/keybase/keybase-bot/pull/116
async function readWithPagination(
  channel: ChatChannel,
  options?: ChatReadOptions
): Promise<ReadResult> {
  await bot.chat._guardInitialized()
  const optionsWithDefaults = {
    ...options,
    channel,
    peek: options && options.peek ? options.peek : false,
    unreadOnly: options && options.unreadOnly !== undefined ? options.unreadOnly : false,
  }
  const res = await bot.chat._runApiCommand({
    apiName: 'chat', method: 'read', options: optionsWithDefaults })
  if (!res) {
    throw new Error('Keybase chat read returned nothing.')
  }
  // Pagination gets passed as-is, while the messages get cleaned up
  return {
    pagination: res.pagination,
    messages: res.messages.map(message => message.msg),
  }
}

type CleanedMessage = {
  id: number,
  text?: string,
  attachment?: {
    path: string,
    asset_type: number
  },
  sent_at: number,
  sender_uid: string,
  sender_username?: string,
  device_id: string,
  device_name?: string,
  revoked_device?: boolean
}

function convertMessage (msg: MessageSummary): ?CleanedMessage {
  const output = {}

  switch (msg.content.type) {
    case 'text':
      output.text = msg.content.text.body
      break

    case 'attachment':
      // TODO: Support attachment downloading
      const { attachment } = msg.content
      output.attachment = {
        path: attachment.object.path,
        asset_type: attachment.object.metadata.assetType
      }
      break

    // TODO: Support reactions
    case 'reaction': return null

    // Skip 'edit' and 'delete' messages
    case 'edit': return null
    case 'delete': return null
  }

  output.id = msg.id
  output.sent_at = msg.sentAt
  output.sender_uid = msg.sender.uid
  output.sender_username = msg.sender.username
  output.device_id = msg.sender.deviceId
  output.device_name = msg.sender.deviceName
  output.revoked_device = msg.revokedDevice

  return output
}

const CHUNK_SIZE = 900 // Shouldn't be more than ~950

async function* loadHistory (channel: ChatChannel) {
  console.log(`loadHistory start: ${channel.name}`)
  let totalMessages = 0
  let next = undefined
  while (true) {
    const { messages, pagination } = await readWithPagination(channel, {
      peek: true,
      pagination: {
        num: CHUNK_SIZE,
        next
      }
    })
    totalMessages += messages.length
    next = pagination.next
    if (messages.length > 0)
      yield messages
    if (pagination.last)
      break
  }
  console.log(`loadHistory end: ${channel.name} (${totalMessages} messages)`)
}

async function saveChunkToEs (chat: ChatConversation, messages: CleanedMessage[]) {
  const indexName = genEsIndexName(chat)
  const preparedChunk: Object[] = messages.reduce((acc, msg) => {
    acc.push({ index: { _id: msg.id.toString() } })
    acc.push(msg)
    return acc
  }, [])
  await elasticClient.bulk({
    index: indexName,
    type: '_doc',
    body: preparedChunk
  })
}

async function saveMessageToEs (chat: ChatConversation, msg: CleanedMessage) {
  const indexName = genEsIndexName(chat)
  await elasticClient.index({
    index: indexName,
    type: '_doc',
    id: msg.id.toString(),
    body: msg
  })
}

/** Used in watcher for saving future editions & deletions */
class MessageStorage {
  +_map
    : Map<number /* id */, {
        msg: CleanedMessage,
        timer: TimeoutID,
        timerFn: (void => void)
      }>
    = new Map();
  +_timeout: number // ms

  constructor (timeout: number /* s */) {
    this._timeout = timeout * 1000
  }

  /** NOTE: Instance can mutate `msg` */
  add (msg: CleanedMessage, timerExpired: CleanedMessage => void) {
    const timerFn = () => {
      this._map.delete(msg.id)
      timerExpired(msg)
    }
    const timer = setTimeout(timerFn, this._timeout)
    this._map.set(msg.id, { msg, timer, timerFn })
  }

  edit (content: EditContent) {
    const id: number = (content.edit: $FlowFixMe).messageId // TODO: Bug in keybase-bot
    const value = this._map.get(id)
    if (!value)
      return debug(`edit: No msg with id ${id}`)
    const { msg, timerFn } = value
    msg.text = content.edit.body
    clearTimeout(value.timer)
    const timer = setTimeout(timerFn, this._timeout)
    value.timer = timer
  }

  delete (content: DeleteContent) {
    for (const id of content.delete.messageIDs) {
      const value = this._map.get(id)
      if (!value) {
        debug(`delete: No msg with id ${id}`)
        continue
      }
      clearTimeout(value.timer)
      this._map.delete(id)
    }
  }
}

function watchChat (chat: ChatConversation): Promise<void> {
  console.log(`Watching for new messages: ${chat.channel.name}`)
  const storage = new MessageStorage(config.watcher.timeout)
  const onMessage = message => {
    console.dir(message)
    console.log(`Watcher: new message (${message.id}): ${chat.channel.name}`)
    switch (message.content.type) {
      case 'edit':
        return storage.edit(message.content)
      case 'delete':
        return storage.delete(message.content)
      default:
        const cleanedMessage = convertMessage(message)
        if (!cleanedMessage) return
        storage.add(cleanedMessage, msg => {
          debug('watchChat save', msg)
          saveMessageToEs(chat, msg).catch(err)
        })
    }
  }
  const onError = error => {
    err(error)
  }
  return bot.chat.watchChannelForNewMessages(chat.channel, onMessage, onError)
}

async function processChat (chat: ChatConversation) {
  if (config.watcher.enabled)
    await watchChat(chat)

  for await (const chunk of loadHistory(chat.channel)) {
    debug(`New chunk (${chunk.length}): ${chat.channel.name}`) // for time displaying
    console.log(`New chunk (${chunk.length}): ${chat.channel.name}`)
    const cleanedMessages = chunk.map(convertMessage).filter(Boolean)
    await saveChunkToEs(chat, cleanedMessages)
    // console.dir(chunk.slice(-3), { depth: null })
  }
}

// TODO: Incremental mode.

async function main () {
  console.log('Initializing')
  await init()

  const { watcher } = config

  if (watcher.enabled) {
    process.on('SIGINT', deinit)
    process.on('SIGTERM', deinit)
  }

  debug('watcher.enabled', watcher.enabled)
  debug('watcher.timeout', watcher.timeout)

  console.log('Getting chat list')
  const chats = await bot.chat.list()
  console.log(`Total chats: ${chats.length}`)
  // debug('Chat list', chats)

  for (const query of config.chats) {
    const chat = findChat(chats, query)
    if (chat)
      await processChat(chat)
    else
      warn(`Chat '${query}' not found`)
  }

  if (!watcher.enabled)
    await deinit()
}

function deinit (): Promise<void> {
  console.log('deinit')
  return bot.deinit()
    // .catch(fatal)
}

elasticClient.ping({})
  .catch(e => { throw new Error(`Elasticsearch is down: ${e}`) })
  .then(() => main())
  .catch(fatal)