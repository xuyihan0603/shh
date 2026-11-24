const api = require('../../lib/api')
const { invitationText, smsFields } = require('../../lib/invitation')

const CHAT_DRAFT_KEY = 'shh.chatTool.draft'
const STOREFRONT_ASSET = '/assets/storefront.jpg'
const EMPTY_DETAILS = {
  loading: true, error: '', needsName: false, notice: '', copyStatus: '',
  card: null, phone: '', message: '', canOpenChat: false, canShareImageMenu: false, canCompose: false, opening: false,
  smsDiagnostic: '', smsHint: '',
  cloudEnabled: false, cloudStatus: '', cloudNote: '', cloudFields: '',
  invitationImagePath: '', generating: false, imageError: '', editingText: false, editText: '',
}
const SMS_REFRESH_ERRORS = ['VERSION_CONFLICT', 'NOTIFY_PENDING', 'GONE', 'UNAUTHORIZED', 'NAME_REQUIRED', 'FORBIDDEN']

function canOpenSms() {
  if (typeof wx.sendSms !== 'function' ||
      (typeof wx.canIUse === 'function' && !wx.canIUse('sendSms'))) return false

  try {
    const { platform } = wx.getDeviceInfo ? wx.getDeviceInfo() : wx.getSystemInfoSync()
    return platform !== 'devtools'
  } catch (_) {}
  return true
}

function smsFailure(error) {
  const reason = String((error && (error.errMsg || error.message)) || '')
  const code = error && (error.errCode ?? error.errno ?? error.code)
  // Keep any recipient number out of the displayed diagnostics.
  const detail = reason.replace(/^sendSms:\s*/i, '').split(/[\r\n]/)[0]
  const bodyTooLong = /内容超出正文上限|(?:content|body).{0,30}(?:too long|exceeds?.{0,20}(?:length|limit))/i.test(detail)
  const safeDetail = bodyTooLong ? '内容超出正文上限' : /^[A-Za-z :_.-]{1,100}$/.test(detail) ? detail : ''
  const safeCode = /^-?\d{1,9}$/.test(String(code)) ? String(code) : ''
  const diagnostic = [safeDetail, safeCode].filter(Boolean).join(' · ') || '微信未提供详细原因'
  if (/cancel|用户取消/i.test(reason)) return { cancelled: true }
  if (/activitynotfound|no activity|no (?:default )?sms app|no application/i.test(reason)) {
    return { diagnostic, hint: '手机找不到短信应用。请在系统设置中选择默认短信应用，再重试。' }
  }
  if (/denied|no permission|not authorized|unauthorized|无权限/i.test(reason)) {
    return { diagnostic, hint: '当前微信未获准打开短信。请手动打开手机短信，填写上方号码并粘贴正文。' }
  }
  if (/not support|unsupported|not implemented|不支持/i.test(reason)) {
    return { diagnostic, hint: '当前微信无法打开短信。请手动打开手机短信，填写上方号码并粘贴正文。' }
  }
  return { diagnostic, hint: '未能打开短信。请手动打开手机短信，填写上方号码并粘贴正文。' }
}

function canOpenChat() {
  return typeof wx.openChatTool === 'function' &&
    (typeof wx.canIUse !== 'function' || wx.canIUse('openChatTool'))
}

function discardChatDraft(token, localImagePath) {
  try {
    const draft = wx.getStorageSync(CHAT_DRAFT_KEY)
    if (draft && draft.token === token) wx.removeStorageSync(CHAT_DRAFT_KEY)
  } catch (_) {}
  if (localImagePath) {
    try { wx.getFileSystemManager().unlinkSync(localImagePath) } catch (_) {}
  }
}

function copyImageForChat(tempImagePath, token, now) {
  const fs = wx.getFileSystemManager()
  const directory = wx.env.USER_DATA_PATH
  // Remove expired handoffs left by an interrupted chat tool.
  for (const name of fs.readdirSync(directory)) {
    const match = /^shh-invite-([0-9a-z]+)-[0-9a-z]+\.jpg$/.exec(name)
    if (match && now - parseInt(match[1], 36) >= 10 * 60 * 1000) {
      try { fs.unlinkSync(directory + '/' + name) } catch (_) {}
    }
  }
  const path = directory + '/shh-invite-' + token + '.jpg'
  fs.copyFileSync(tempImagePath, path)
  return path
}

Page({
  data: {
    ...EMPTY_DETAILS,
    id: '', smsOnly: false, sending: false, chatOpening: false, chatNotice: '',
  },

  onLoad(query = {}) {
    const smsOnly = query.channel === 'sms'
    this.setData({ id: query.id || '', smsOnly })
    if (smsOnly) wx.setNavigationBarTitle({ title: '发送预订短信' })
    if (typeof wx.hideShareMenu === 'function') wx.hideShareMenu({})
  },

  onShow() {
    if (this.hidden) this.smsAttempt = null
    this.hidden = false
    this.load()
  },

  onHide() {
    this.hidden = true
    this.setData({ chatNotice: '' })
    this.clearDetails()
  },

  onUnload() {
    this.unloaded = true
    this.requestId = (this.requestId || 0) + 1
    this.details = null
    this.smsSession = null
    this.smsAttempt = null
    this.clipboardRequest = null
    this.revisedMessage = null
  },

  clearDetails() {
    this.requestId = (this.requestId || 0) + 1
    this.details = null
    this.clipboardRequest = null
    this.setData(EMPTY_DETAILS)
    return this.requestId
  },

  async load() {
    const { id, smsOnly } = this.data
    const requestId = this.clearDetails()
    if (!id) {
      this.setData({ loading: false, error: '缺少订单编号。' })
      return
    }

    try {
      const details = await api.call('notificationDetails', { id })
      if (this.requestId !== requestId) return
      const { card, sms } = details
      if (!card || (smsOnly && !sms)) throw new Error('预订消息资料不完整，请联系店长或管理员。')
      const preview = { loading: false, card, message: invitationText(smsOnly ? card : { ...card, address: '' }) }
      this.details = details
      if (smsOnly) {
        if (!this.smsSession || this.smsSession.id !== id || this.smsSession.version !== details.version) {
          this.smsAttempt = null
          this.smsSession = { id, version: details.version, diagnostic: '', hint: '' }
        }
        const session = this.smsSession
        this.setData({
          ...preview,
          phone: sms.phone || '', canCompose: canOpenSms(),
          smsDiagnostic: session.diagnostic, smsHint: session.hint, opening: Boolean(this.smsAttempt),
        })
      } else {
        const revision = this.revisedMessage
        const currentRevision = revision && revision.version === details.version && revision.original === preview.message
        this.setData({
          ...preview, canOpenChat: canOpenChat(), canShareImageMenu: typeof wx.showShareImageMenu === 'function',
          message: currentRevision ? revision.text : preview.message,
          phone: sms?.phone || '',
          cloudEnabled: !details.trial && Boolean(sms?.enabled) && sms.status !== 'accepted' && sms.status !== 'pending',
          cloudStatus: details.trial ? '' : sms?.status || '',
          cloudNote: details.trial ? '' : sms?.reason || '',
          cloudFields: smsFields(card).join(' · '),
        }, () => { if (this.details === details) this.generateImage() })
      }
    } catch (error) {
      if (this.requestId === requestId) {
        this.revisedMessage = null
        this.smsSession = null
        this.smsAttempt = null
        this.setData({
          loading: false, needsName: error.code === 'NAME_REQUIRED',
          error: error.message || '预订消息加载失败，请重试。',
        })
      }
    }
  },

  openAccount() {
    wx.switchTab({ url: '/pages/account/index' })
  },

  async generateImage() {
    const { card, message, smsOnly, generating } = this.data
    if (!card || smsOnly || generating || !message.trim()) return
    const details = this.details
    this.setData({ generating: true, invitationImagePath: '', imageError: '', chatNotice: '' })
    // A new order or another visit to the page must not draw over an export in progress.
    const render = (this.imageWork || Promise.resolve()).then(async () => {
      if (this.details !== details) return
      const canvas = await new Promise((resolve, reject) => {
        this.createSelectorQuery().select('#invitation-image-canvas').fields({ node: true }).exec(result => {
          if (result?.[0]?.node) resolve(result[0].node)
          else reject(new Error('Canvas unavailable'))
        })
      })
      const { createInvitationImage } = require('../../lib/invitation-image')
      return createInvitationImage(canvas, message, card.store === '珊瑚海' ? STOREFRONT_ASSET : null)
    })
    this.imageWork = render.catch(() => {})
    try {
      const invitationImagePath = await render
      if (this.details === details) this.setData({ invitationImagePath, generating: false })
    } catch (error) {
      if (this.details === details) this.setData({
        generating: false, imageError: error?.code === 'TEXT_TOO_LONG'
          ? '文字过长，请点「编辑文字」缩短后重新生成。' : '预订图生成失败，请重新生成。',
      })
    }
  },

  editMessage() {
    if (this.data.generating || this.data.chatOpening) return
    this.setData({ editingText: true, editText: this.data.message, chatNotice: '' })
  },

  changeText(event) {
    this.setData({ editText: event.detail.value })
  },

  finishEditing(event) {
    if (event.currentTarget.dataset.cancel || this.data.editText === this.data.message) {
      this.setData({ editingText: false })
      return
    }
    if (!this.data.editText.trim()) {
      wx.showToast({ title: '请输入预订文字', icon: 'none' })
      return
    }
    this.revisedMessage = {
      version: this.details.version, original: invitationText({ ...this.data.card, address: '' }), text: this.data.editText,
    }
    this.setData({ editingText: false, message: this.data.editText, invitationImagePath: '' }, () => this.generateImage())
  },

  openChat() {
    const { card, smsOnly, invitationImagePath, editingText, canOpenChat, canShareImageMenu } = this.data
    if (!card || smsOnly || editingText || !invitationImagePath || this.chatRequest) return
    if (!canOpenChat) {
      if (canShareImageMenu) wx.showShareImageMenu({
        path: invitationImagePath, needShowEntrance: false,
        fail: error => {
          if (!this.hidden && !this.unloaded && !/cancel|取消/i.test(error?.errMsg || '')) {
            this.setData({ chatNotice: '请长按预订图，选择「发送给朋友」。' })
          }
        },
      })
      return
    }

    const createdAt = Date.now()
    const token = createdAt.toString(36) + '-' + Math.random().toString(36).slice(2)
    let localImagePath
    this.chatRequest = token
    this.setData({ chatOpening: true, chatNotice: '', copyStatus: '' })

    const finish = (chatNotice = '') => {
      if (this.chatRequest !== token) return
      this.chatRequest = null
      if (!this.unloaded) this.setData({ chatOpening: false, chatNotice })
    }
    const fail = error => {
      discardChatDraft(token, localImagePath)
      const cancelled = /cancel|取消/i.test((error && error.errMsg) || '')
      finish(cancelled
        ? '已取消选择联系人。'
        : '无法打开联系人列表，可长按预订图发送给朋友。')
    }

    try {
      localImagePath = copyImageForChat(invitationImagePath, token, createdAt)
      wx.setStorageSync(CHAT_DRAFT_KEY, { token, invitationImagePath: localImagePath, createdAt })
      wx.openChatTool({
        url: '/chat-tool/pages/send/index?token=' + token,
        success: () => finish(),
        fail,
      })
    } catch (error) {
      fail(error)
    }
  },

  openSms(phone) {
    const session = this.smsSession
    const attempt = {}
    this.smsAttempt = attempt
    this.setData({ opening: true })
    const finish = failure => {
      if (this.smsAttempt !== attempt || this.smsSession !== session) return
      this.smsAttempt = null
      session.diagnostic = failure?.diagnostic || ''
      session.hint = failure?.hint || ''
      if (!this.hidden && !this.unloaded && this.data.card) {
        this.setData({ opening: false, smsDiagnostic: session.diagnostic, smsHint: session.hint })
      }
    }
    try {
      // The text is on the clipboard so the native call can omit its length-limited body.
      wx.sendSms({
        phoneNumber: phone,
        success: () => finish(),
        fail: error => finish(smsFailure(error)),
        complete: () => finish(),
      })
    } catch (error) {
      finish(smsFailure(error))
    }
  },

  copy() {
    const { card, smsOnly, phone, message, canCompose, opening, sending } = this.data
    if (!smsOnly || !card || !message || this.clipboardRequest || opening || sending || this.hidden || this.unloaded) return

    const clipboardRequest = {}
    this.clipboardRequest = clipboardRequest
    this.setData({ copyStatus: 'copying', chatNotice: '', smsDiagnostic: '', smsHint: '' })
    const setStatus = copyStatus => {
      if (this.clipboardRequest !== clipboardRequest) return
      this.clipboardRequest = null
      this.setData({ copyStatus })
      if (copyStatus === 'success' && smsOnly && phone && canCompose) this.openSms(phone)
    }
    try {
      wx.setClipboardData({
        data: message,
        success: () => setStatus('success'),
        fail: () => setStatus('failed'),
      })
    } catch (_) {
      setStatus('failed')
    }
  },

  sendCloud() {
    const { cloudEnabled, sending, smsOnly, phone } = this.data
    const details = this.details
    if (!details || !cloudEnabled || sending || smsOnly) return
    wx.showModal({
      title: '用门店短信发送',
      content: '将使用门店短信服务向 ' + phone + ' 发送本次预订通知。',
      confirmText: '确认发送',
      confirmColor: '#103947',
      success: result => { if (result.confirm) this.submitCloud(details) },
    })
  },

  async submitCloud(details) {
    const { id, cloudEnabled, sending, smsOnly } = this.data
    if (this.details !== details || !cloudEnabled || sending || smsOnly) return
    this.setData({ sending: true, notice: '' })
    try {
      await api.call('notifySms', { id, version: details.version })
      if (this.details === details) {
        this.setData({ cloudStatus: 'accepted', cloudEnabled: false })
      } else if (!this.hidden && !this.unloaded) {
        await this.load()
      }
    } catch (error) {
      if (this.hidden || this.unloaded) return
      if (this.details !== details || SMS_REFRESH_ERRORS.includes(error.code)) await this.load()
      if (this.details) this.setData({ notice: error.message || '短信提交失败，请重试。' })
    } finally {
      if (!this.unloaded) this.setData({ sending: false })
    }
  },
})
