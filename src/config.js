// @flow

import fs from 'fs'
import * as Joi from 'joi'
// import { fatal } from './log'

type Config = {
  chats: string[],
  init: {|
    type: 'init',
    username: string,
    paperkey: string
  |} | {|
    // NOTE: With this setting watcher doesn't collect user's own messages
    type: 'initFromRunningService'
  |},
  watcher: {|
    enabled: boolean,
    timeout: number // seconds
  |},
  // incremental: {|
  //   enabled: boolean,
  //   sessionFile: string
  // |},
    // "incremental": {
    //   "enabled": true,
    //   "sessionFile": "keybase-export.session"
    // },
  elasticsearch: {|
    enabled: boolean, // false is not supported currently
    indexPattern: string,
    config: Object // ElasticSearch config
  |}
}

const schema = Joi.object().keys({
  chats: Joi.array().items(Joi.string()),
  init: Joi.alternatives(
    Joi.object().keys({
      type: Joi.string().valid('init'),
      username: Joi.string(),
      paperkey: Joi.string()
    }),
    Joi.object().keys({
      type: Joi.string().valid('initFromRunningService')
    })
  ),
  watcher: Joi.object().keys({
    enabled: Joi.boolean(),
    timeout: Joi.number()
  }),
  // incremental: Joi.object().keys({
  //   enabled: Joi.boolean(),
  //   sessionFile: Joi.string()
  // }),
  elasticsearch: Joi.object().keys({
    enabled: Joi.boolean(),
    indexPattern: Joi.string(),
    config: Joi.object()
  })
}).unknown(true)

// const CONFIG_PATH = 'config.example.json'
const CONFIG_PATH = 'config.json'

const untrustedConfig = JSON.parse(fs.readFileSync(CONFIG_PATH).toString())

const result = Joi.validate((untrustedConfig: Config), schema)

if (result.error) throw result.error

export const config = result.value