const fs = require('fs')
const EventEmitter = require('events')

const lib = require('./lib/lib.js')
const attachemntUtils = require('./lib/attachments.js')
const openGroupUtils = require('./lib/open_groups.js')
const keyUtil = require('./external/mnemonic/index.js')

/**
 * Default home server URL
 * @constant
 * @default
 */
const FILESERVER_URL = 'https://file.getsession.org/' // path required!

/**
 * Creates a new Session client
 * @class
 * @property {Number} pollRate How much delay between poll requests
 * @property {Number} lastHash Poll for messages from this hash on
 * @property {String} displayName Send messages with this profile name
 * @property {String} homeServer HTTPS URL for this identity's file server
 * @property {String} fileServerToken Token for avatar operations
 * @property {String} identityOutput human readable string with seed words if generated a new identity
 * @property {String} ourPubkeyHex This identity's pubkey (SessionID)
 * @property {object} keypair This identity's keypair buffers
 * @property {Boolean} open Should we continue polling for messages
 * @property {String} encAvatarUrl Encrypted avatar URL
 * @property {Buffer} profileKeyBuf Key to decrypt avatar URL
 * @implements EventEmitter
 * @module session-client
 * @exports SessionClient
 * @author Ryan Tharp
 * @license ISC
 * @tutorial sample.js
 */
class SessionClient extends EventEmitter {
  /**
   * @constructor
   * @param {object} [options] Creation client options
   * @param {Number} [options.pollRate] How much delay between poll requests, Defaults: 1000
   * @param {Number} [options.lastHash] lastHash Poll for messages from this hash on Defaults: '' (Read all messages)
   * @param {Number} [options.homeServer] Which server holds your profile and attachments Defaults: https://file.getsession.org/
   * @param {Number} [options.displayName] Send messages with this profile name, Defaults: false (Don't send a name)
   * @example
   * const sessionClient = new SessionClient()
   */
  constructor(options = {}) {
    super()
    this.pollRate = options.pollRate || 3000
    this.lastHash = options.lastHash || ''
    this.homeServer = options.homeServer || FILESERVER_URL
    this.fileServerToken = options.fileServerToken || ''
    this.displayName = options.displayName || false
    this.openGroupServers = {}
    this.pollServer = false
    this.groupInviteTextTemplate = '{pubKey} has invited you to join {name} at {url}'
    this.groupInviteNonC1TextTemplate = ' You may not be able to join this channel if you are using a mobile session client'
    this.lastPoll = 0
  }

  // maybe a setName option
  // we could return identityOutput
  // also identityOutput in a more structured way would be good
  /**
   * set an identity for this session client
   * sets this.identityOutput
   * @public
   * @param {Object} options a list of options of how to set up the identity
   * @param {string} [options.seed] a space separate list of seed words
   * @param {Object} [options.keypair] a buffer keypair
   * @param {buffer} options.keypair.privKey a buffer that contains a curve25519-n private key
   * @param {buffer} options.keypair.pubKey a buffer that contains a curve25519-n public key
   * @param {string} [options.displayName] use this string as the profile name for messages
   * @param {string} [options.avatarFile] path to an image file to use as avatar
   * @example
   * client.loadIdentity({
   *   seed: fs.existsSync('seed.txt') && fs.readFileSync('seed.txt').toString(),
   *   //displayName: 'Sample Session Client',
   *   //avatarFile: 'avatar.png',
   * }).then(async() => {
   *   // Do stuff
   * })
   */
  async loadIdentity(options = {}) {
    if (options.seed) {
      // decode seed into keypair
      options.keypair = keyUtil.wordsToKeyPair(options.seed)
      this.identityOutput = 'Loaded SessionID ' + options.keypair.pubKey.toString('hex') + ' from seed words'
    }
    // ensure keypair
    if (!options.keypair) {
      const res = await keyUtil.newKeypair()
      this.identityOutput = 'SessionID ' + res.keypair.pubKey.toString('hex') + ' seed words: ' + res.words
      options.keypair = res.keypair
    }
    if (options.displayName) {
      this.displayName = options.displayName
    }
    // process keypair
    this.keypair = options.keypair
    this.ourPubkeyHex = options.keypair.pubKey.toString('hex')
    // we need ourPubkeyHex set
    if (options.avatarFile) {
      if (fs.existsSync(options.avatarFile)) {
        let avatarOk = false
        const avatarDisk = fs.readFileSync(options.avatarFile)
        // is this image uploaded to the server?
        const avatarRes = await attachemntUtils.getAvatar(FILESERVER_URL,
          this.ourPubkeyHex
        )
        if (!avatarRes) {
          console.warn('SessionClient::loadIdentity - getAvatar failure', avatarRes)
        } else {
          this.encAvatarUrl = avatarRes.url
          this.profileKeyBuf = Buffer.from(avatarRes.profileKey64, 'base64')
          const netData = await attachemntUtils.downloadEncryptedAvatar(
            this.encAvatarUrl, this.profileKeyBuf
          )
          if (!netData) {
            console.warn('SessionClient::loadIdentity - downloadEncryptedAvatar failure', netData)
          } else {
            if (avatarDisk.byteLength !== netData.byteLength ||
              Buffer.compare(avatarDisk, netData) !== 0) {
              console.log('SessionClient::loadIdentity - detected avatar change, replacing')
              await this.changeAvatar(avatarDisk)
            } else {
              avatarOk = true
            }
          }
        }
        if (!avatarOk) {
          console.log('SessionClient::loadIdentity - unable to read avatar state, resetting avatar')
          await this.changeAvatar(avatarDisk)
        }
      } else {
        console.error('SessionClient::loadIdentity - avatarFile', options.avatarFile, 'is not found')
      }
    }
  }

  /**
   * start listening for messages
   * @public
   */
  async open() {
    if (!this.ourPubkeyHex || this.ourPubkeyHex.length < 66) {
      console.error('no identity loaded')
      return
    }
    //console.log('open - validated', this.ourPubkeyHex)
    // lazy load recv library
    if (!this.recvLib) {
      /**
       * @private
       * @property {Object} recvLib
       */
      this.recvLib = require('./lib/recv.js')
    }
    //console.log('library loaded', this.ourPubkeyHex)
    this.pollServer = true

    // start polling our box
    //console.log('start poll', this.ourPubkeyHex)
    await this.poll()
    //console.log('start watchdog', this.ourPubkeyHex)
    this.watchdog() // backup for production use
  }

  /**
   * watch poller, and make sure it's running if it should be running
   * @private
   */
  async watchdog() {
    // if closed
    if (!this.pollServer) {
      return // don't reschedule
    }
    // make sure we've polled successfully at least once
    if (this.lastPoll) {
      const ago = Date.now() - this.lastPoll
      // if you missed 10 polls in a roll
      if (ago > this.pollRate * 10 * 5) {
        this.lastPoll = Date.now() // prevent amplification
        console.warn('SessionClient::watchdog - polling failure, restarting poller', ago, this.pollRate)
        //this.poll()
      }
    }
    // schedule us again
    setTimeout(() => {
      this.watchdog()
    }, this.pollRate)
  }

  /**
   * poll storage server for messages and emit events
   * @public
   * @fires SessionClient#updateLastHash
   * @fires SessionClient#preKeyBundle
   * @fires SessionClient#receiptMessage
   * @fires SessionClient#nullMessage
   * @fires SessionClient#messages
   */
  async poll() {
    // if closed
    if (!this.pollServer) {
      if (this.debugTimer) console.log('closed...')
      return // don't reschedule
    }
    if (this.debugTimer) console.log('polling...', this.ourPubkeyHex)
    const dmResult = await this.recvLib.checkBox(
      this.ourPubkeyHex, this.keypair, this.lastHash, lib, this.debugTimer
    )
    const groupResults = (await Promise.all(Object.keys(this.openGroupServers).map(async (openGroup) => {
      //console.log('poll - polling open group', openGroup, this.openGroupServers[openGroup])
      //console.log('poll - open group token', this.openGroupServers[openGroup].token)
      const groupMessages = await this.openGroupServers[openGroup].getMessages()
      if (groupMessages && groupMessages.length > 0) {
        return { openGroup, groupMessages }
      }
      return undefined
    }))).filter((m) => !!m)

    if (this.debugTimer) console.log('polled...', this.ourPubkeyHex)
    if (dmResult || groupResults.length > 0) {
      const messages = []
      if (dmResult) {
        if (dmResult.lastHash !== this.lastHash) {
          /**
           * Handle when the cursor in the pubkey's inbox moves
           * @callback updateLastHashCallback
           * @param {String} hash The last hash returns from the storage server for this pubkey
           */
          /**
           * Exposes the last hash, so you can persist between reloads where you left off
           * and not process commands twice
           * @event SessionClient#updateLastHash
           * @type updateLastHashCallback
           */
          this.emit('updateLastHash', dmResult.lastHash)
          this.lastHash = dmResult.lastHash
        }
        if (dmResult.messages.length) {
          // emit them...

          dmResult.messages.forEach(msg => {
            //console.log('poll -', msg)
            // separate out simple messages to make it easier
            if (msg.dataMessage && (msg.dataMessage.body || msg.dataMessage.attachments)) {
              // maybe there will be something here...
              //console.log('pool dataMessage', msg)
              // skip session resets
              // desktop: msg.dataMessage.body === 'TERMINATE' &&
              if (!(msg.flags === 1)) { // END_SESSION
                // escalate source
                messages.push({ ...msg.dataMessage, source: msg.source })
              }
            } else
            if (msg.preKeyBundleMessage) {
              /**
                 * content protobuf
                 * @callback messageCallback
                 * @param {object} content Content protobuf
                 */
              /**
                 * Received pre-key bundle message
                 * @event SessionClient#preKeyBundle
                 * @type messageCallback
                 */
              this.emit('preKeyBundle', msg)
            } else
            if (msg.receiptMessage) {
              /**
                   * Read Receipt message
                   * @event SessionClient#receiptMessage
                   * @type messageCallback
                   */
              this.emit('receiptMessage', msg)
            } else
            if (msg.nullMessage) {
              /**
                     * session established message
                     * @event SessionClient#nullMessage
                     * @type messageCallback
                     */
              this.emit('nullMessage', msg)
            } else {
              console.log('poll - unhandled message', msg)
            }
          })
        }

        if (groupResults.length) {
          groupResults.forEach(group => group.groupMessages.forEach(message => {
            // Exclude our own messages
            if (message.user.username !== this.ourPubkeyHex) {
              messages.push({
                id: message.id,
                openGroup: group.openGroup,
                body: message.text,
                profile: {
                  id: message.user.id,
                  displayName: message.user.name,
                  avatar: message.user.avatar_image.url,
                },
                source: message.user.username,
              })
            }
          }))
        }

        if (messages.length) {
          /**
           * content dataMessage protobuf
           * @callback messagesCallback
           * @param {Array} messages an array of Content protobuf
           */
          /**
           * Messages usually with content
           * @module session-client
           * @event SessionClient#messages
           * @type messagesCallback
           */
          this.emit('messages', messages)
        }
      }
    }
    this.lastPoll = Date.now()
    if (this.debugTimer) console.log('scheduled...')
    setTimeout(() => {
      if (this.debugTimer) console.log('firing...')
      this.poll()
    }, this.pollRate)
  }

  /**
   * stop listening for messages
   * @public
   */
  close() {
    if (this.debugTimer) console.log('closing')
    this.pollServer = false
  }

  /**
   * get and decrypt all attachments
   * @public
   * @param {Object} message message to download attachments from
   * @return {Promise<Array>} an array of buffers of downloaded data
   */
  async getAttachments(msg) {
    /*
    attachment AttachmentPointer {
      id: Long { low: 159993, high: 0, unsigned: true },
      contentType: 'image/jpeg',
      key: Uint8Array(64) [
        132, 169, 117,  10, 194,  47, 216,  60,  27,   1, 227,
         49,  16, 116, 170,  67,  89, 135, 139,  11,  75,  54,
        130, 184,  16, 174, 252,  26, 164, 251, 114, 244,  37,
        180,  52, 139, 149, 108,  60,  16,  63, 154, 161,  80,
         85, 198,  90, 116,  56, 214, 212, 111, 156,  55, 221,
         44,  39, 202,  46,   4, 190, 169, 193,  26
      ],
      size: 6993,
      digest: Uint8Array(32) [
        193,  15, 127,  86,  79,   0, 239, 104,
        202, 189,  49, 238,  79, 192, 119, 168,
        221, 223, 237,  30, 171, 191,  48, 181,
         94,   6,   7, 155, 209, 116,  84, 171
      ],
      fileName: 'images.jpeg',
      url: 'https://file-static.lokinet.org/f/ciebnq'
    }
    */
    return Promise.all(msg.attachments.map(async attachment => {
      // attachment.key
      // could check digest too (should do that inside decryptCBC tho)
      const res = await attachemntUtils.downloadEncryptedAttachment(attachment.url, attachment.key)
      //console.log('attachmentRes', res)
      return res
    }))
  }

  /**
   * get and decrypt all attachments
   * @public
   * @param {Buffer} data image data
   * @return {Promise<Object>} returns an attachmentPointer
   */
  async makeImageAttachment(data) {
    return attachemntUtils.uploadEncryptedAttachment(this.homeserver, data)
  }

  /**
   * get file server token for avatar operations
   * @private
   * @fires SessionClient#fileServerToken
   */
  async ensureFileServerToken() {
    if (!this.fileServerToken) {
      // we need a token...
      this.fileServerToken = await attachemntUtils.getToken(
        this.homeserver, this.keypair.privKey, this.ourPubkeyHex
      )
      /**
       * Handle when we get a new home server token
       * @callback fileServerTokenCallback
       * @param {string} token The new token for their home server
       */
      /**
       * Exposes identity's home server token, to speed up start up
       * @event SessionClient#fileServerToken
       * @type fileServerTokenCallback
       */
      this.emit('fileServerToken', this.fileServerToken)
    }
    // else maybe verify token
  }

  /**
   * Change your avatar
   * @public
   * @param {Buffer} data image data
   * @return {Promise<object>} avatar's URL and profileKey to decode
   * @uses ensureFileServerToken
   */
  async changeAvatar(data) {
    if (!this.ourPubkeyHex) {
      console.error('SessionClient::changeAvatar - Identity not set up yet')
      return
    }
    await this.ensureFileServerToken()
    const res = await attachemntUtils.uploadEncryptedAvatar(
      this.homeserver, this.fileServerToken, this.ourPubkeyHex, data)
    //console.log('SessionClient::changeAvatar - res', res)
    /* profileKeyBuf: buffer
      url: string */

    // update our state
    this.encAvatarUrl = res.url
    this.profileKeyBuf = res.profileKeyBuf

    return res
  }

  /**
   * decode an avatar (usually from a message)
   * @public
   * @param {String} url Avatar URL
   * @param {Uint8Array} profileKeyUint8
   * @returns {Promise<Buffer>} a buffer containing raw binary data for image of avatar
   */
  async decodeAvatar(url, profileKeyUint8) {
    const buf = Buffer.from(profileKeyUint8)
    return attachemntUtils.downloadEncryptedAvatar(url, buf)
  }

  /**
   * get any one's avatar
   * @public
   * @param {String} url User's home server URL
   * @param {String} pubkeyHex Who's avatar you want
   * @returns {Promise<Buffer>} a buffer containing raw binary data for image of avatar
   */
  async getAvatar(fSrvUrl, pubkeyHex) {
    return attachemntUtils.downloadEncryptedAvatar(fSrvUrl, pubkeyHex)
  }

  /**
   * Send a Session message
   * @public
   * @param {String} destination pubkey of who you want to send to
   * @param {String} [messageTextBody] text message to send
   * @param {object} [options] Send options
   * @param {object} [options.attachments] Attachment Pointers to send
   * @param {String} [options.displayName] Profile name to send as
   * @param {object} [options.avatar] Avatar URL/ProfileKey to send
   * @param {object} [options.groupInvitation] groupInvitation to send
   * @param {object} [options.flags] message flags to set
   * @param {object} [options.nullMessage] include a nullMessage
   * @returns {Promise<Bool>} If operation was successful or not
   * @example
   * sessionClient.send('05d233c6c8daed63a48dfc872a6602512fd5a18fc764a6d75a08b9b25e7562851a', 'I didn\'t change the pubkey')
   */
  async send(destination, messageTextBody, options = {}) {
    // lazy load recv library
    if (!this.sendLib) {
      this.sendLib = require('./lib/send.js')
    }
    const sendOptions = { ...options }
    if (this.displayName) sendOptions.displayName = this.displayName
    if (this.encAvatarUrl && this.profileKeyBuf) {
      sendOptions.avatar = {
        url: this.encAvatarUrl,
        profileKeyBuf: this.profileKeyBuf
      }
    }
    return this.sendLib.send(destination, this.keypair, messageTextBody, lib, sendOptions)
  }

  /**
   * Send an open group invite
   * Currently works on desktop not on iOS/Android
   * @public
   * @param {String} destination pubkey of who you want to send to
   * @param {String} serverName Server description
   * @param {String} serverAddress Server URL
   * @param {Number} channelId Channel number
   * @returns {Promise<Bool>} If operation was successful or not
   * @example
   * sessionClient.sendOpenGroupInvite('05d233c6c8daed63a48dfc872a6602512fd5a18fc764a6d75a08b9b25e7562851a', 'Session Chat', 'https://chat.getsession.org/', 1)
   */
  async sendOpenGroupInvite(destination, serverName, serverAddress, channelId) {
    return this.sendLib.send(destination, this.keypair, undefined, lib, {
      groupInvitation: {
        serverAddress: serverAddress,
        channelId: parseInt(channelId),
        serverName: serverName
      }
    })
  }

  /**
   * Send an open group invite with additional text for mobile
   * @public
   * @param {String} destination pubkey of who you want to send to
   * @param {String} serverName Server description
   * @param {String} serverAddress Server URL
   * @param {Number} channelId Channel number
   * @returns {Promise<Bool>} If operation was successful or not
   * @example
   * sessionClient.sendOpenGroupInvite('05d233c6c8daed63a48dfc872a6602512fd5a18fc764a6d75a08b9b25e7562851a', 'Session Chat', 'https://chat.getsession.org/', 1)
   */
  async sendSafeOpenGroupInvite(destination, serverName, serverAddress, channelId) {
    // FIXME: maybe send a text with this
    channelId = parseInt(channelId)
    // this.groupInviteTextTemplate = '{pubKey} has invited you to join {name} at {url}'
    let msg = this.groupInviteTextTemplate.replace(/{pubKey}/g, this.ourPubkeyHex)
    msg = msg.replace(/{name}/g, serverName)
    msg = msg.replace(/{url}/g, serverAddress)
    if (channelId !== 1) {
      msg += this.groupInviteNonC1TextTemplate
    }
    await this.send(destination, msg)
    return this.sendOpenGroupInvite(destination, serverName, serverAddress, channelId)
  }

  /**
   * Request a session reset
   * @public
   * @param {String} destination pubkey of who you want to send to
   * @returns {Promise<Bool>} If operation was successful or not
   * @example
   * sessionClient.sendSessionReset('05d233c6c8daed63a48dfc872a6602512fd5a18fc764a6d75a08b9b25e7562851a')
   */
  async sendSessionReset(destination) {
    return this.sendLib.send(destination, this.keypair, 'TERMINATE', lib, {
      flags: 1
    })
  }

  /**
   * Respond that session has been established
   * @public
   * @param {String} destination pubkey of who you want to send to
   * @returns {Promise<Bool>} If operation was successful or not
   * @example
   * sessionClient.sendSessionEstablished('05d233c6c8daed63a48dfc872a6602512fd5a18fc764a6d75a08b9b25e7562851a')
   */
  async sendSessionEstablished(destination) {
    return this.sendLib.send(destination, this.keypair, '', lib, {
      nullMessage: true
    })
  }

  /**
   * Join Open Group, Receive Open Group token
   * @public
   * @todo also accept with protocol for .loki support
   * @param {String} open group URL (without protocol)
   * @param {Number} open group Channel
   * @returns {Promise<Object>} Object {token: {String}, channelId: {Int}, lastMessageId: {Int}}
   * @example
   * sessionClient.joinOpenGroup('chat.getsession.org')
   */
  async joinOpenGroup(openGroupURL, channelId = 1) {
    console.log('Joining Open Group', openGroupURL)
    const id = openGroupURL + '_' + channelId
    this.openGroupServers[id] = new openGroupUtils.SessionOpenGroupChannel(openGroupURL, {
      channelId: channelId,
      keypair: this.keypair,
    })
    this.openGroupServers[id].token = await openGroupUtils.getToken(openGroupURL,
      this.keypair.privKey, this.ourPubkeyHex)

    const subscriptionResult = await this.openGroupServers[id].subscribe()
    this.openGroupServers[id].lastId = subscriptionResult && subscriptionResult.data && subscriptionResult.data.recent_message_id

    // stay backwards compatible
    return {
      token: this.openGroupServers[id].token,
      channelId: channelId,
      lastMessageId: this.openGroupServers[id].lastId,
      handle: this.openGroupServers[id],
      id: id // best to pass to other functions...
    }
  }

  /**
   * Send Open Group Message
   * @public
   * @param {String} open group URL (without protocol)
   * @param {String} message text body
   * @param {Object} additional options - not yet implemented
   * @returns {Promise<Int>} ID of sent message, zero if not successfully sent
   * @example
   * sessionClient.joinOpenGroup('chat.getsession.org')
   */
  async sendOpenGroupMessage(openGroup, messageTextBody, options = {}) {
    // attempt to be backwards compatible
    if (!this.openGroupServers[openGroup]) {
      openGroup = openGroup.replace('_1', '')
    }
    if (!this.openGroupServers[openGroup]) {
      console.error('sendOpenGroupMessage - no such openGroup', openGroup)
      return false
    }
    const sendMessageResult = await this.openGroupServers[openGroup].send(messageTextBody)
    return sendMessageResult
  }

  /**
     * Delete Open Group Message
     * @public
     * @param {String} open group URL (without protocol)
     * @param {Array<Int>} array of message IDs to delete
     * @returns {Promise<Object>} result of deletion
     * @example
     * sessionClient.joinOpenGroup('chat.getsession.org')
     */
  async deleteOpenGroupMessage(openGroup, messageIds) {
    // attempt to be backwards compatible
    if (!this.openGroupServers[openGroup]) {
      openGroup = openGroup.replace('_1', '')
    }
    if (!this.openGroupServers[openGroup]) {
      console.error('deleteOpenGroupMessage - no such openGroup', openGroup)
      return false
    }
    const deleteMessageResult = await this.openGroupServers[openGroup].messageDelete(messageIds)
    return deleteMessageResult
  }
}

module.exports = SessionClient
