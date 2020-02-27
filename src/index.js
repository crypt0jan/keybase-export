// @flow

import Debug from 'debug'
import Bot from 'keybase-bot'
import { warn, err, fatal } from './log'
import { config } from './config'
import { Dumper } from './dump'
import { MessageStorage } from './message-storage'

import type { CleanedMessage } from './types'

type ChatConversation = any
type ChatChannel = any
type MessageSummary = any
type Asset = any

const debug = Debug('keybase-export')

const bot = new Bot()
const dumper = new Dumper()

const INIT_OPTIONS = {
  disableTyping: true
}

async function init () {
  const initConfig = config.init
  if (initConfig.type === 'initFromRunningService') {
    debug('init: initFromRunningService start')
    await bot.initFromRunningService()
  } else {
    debug('init: init start')
    await bot.init(initConfig.username, initConfig.paperkey, INIT_OPTIONS)
  }
  debug('init: end')
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

function addAttachmentStub (object: Asset) {
  if (!config.attachments.addStub) return object.title
  const space = object.title === '' ? '' : ' '
  return `[Attachment ${object.filename}]${space}${object.title}`
}

function convertMessage (msg: MessageSummary): ?CleanedMessage {
  const output = {}

  switch (msg.content.type) {
    case 'text':
      const { text } = msg.content
      output.text = text.body
      // $FlowFixMe: TODO: Update typings
      output.reply_to = text.replyTo
      break

    case 'attachment':
      // TODO: Support attachment downloading
      const { attachment } = msg.content
      const { object } = attachment
      output.attachment = {
        path: object.path,
        asset_type: object.metadata.assetType
      }
      output.text = addAttachmentStub(object)
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
    const { messages, pagination } = await bot.chat.read(channel, {
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

function watchChat (chat: ChatConversation): Promise<void> {
  console.log(`Watching for new messages: ${chat.channel.name}`)
  const storage = new MessageStorage(config.watcher.timeout)
  const onMessage = message => {
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
          dumper.saveMessage(chat, msg)
            .catch(err)
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
    await dumper.saveChunk(chat, cleanedMessages)
    // console.dir(chunk.slice(-3), { depth: null })
  }
}

// TODO: Incremental mode.

async function main () {
  console.log('Initializing')

  await init()

  process.on('SIGINT', deinit)
  process.on('SIGTERM', deinit)

  const { watcher } = config

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
    .catch(fatal)
}

dumper.init()
  .then(main)
  .catch(fatal)
