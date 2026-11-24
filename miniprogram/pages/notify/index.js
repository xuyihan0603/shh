const api = require('../../lib/api')
const { invitationText, compactSms, smsFields } = require('../../lib/invitation')

const CHAT_DRAFT_KEY = 'shh.chatTool.draft'
const EMPTY_DETAILS = {
  loading: true, error: '', needsName: false, notice: '', copyStatus: '',
  card: null, phone: '', message: '', canOpenChat: false, canCompose: false, opening: '',
  smsMode: 'manual', smsDiagnostic: '', smsHint: '', smsCopied: '', shortSms: null,
  cloudEnabled: false, cloudStatus: '', cloudNote: '', cloudFields: '',
}
const SMS_REFRESH_ERRORS = ['VERSION_CONFLICT', 'NOTIFY_PENDING', 'GONE', 'UNAUTHORIZED', 'NAME_REQUIRED', 'FORBIDDEN']

function defaultSmsMode() {
  if (typeof wx.sendSms !== 'function' ||
      (typeof wx.canIUse === 'function' && !wx.canIUse('sendSms'))) return 'manual'

  try {
    const { platform } = wx.getDeviceInfo ? wx.getDeviceInfo() : wx.getSystemInfoSync()
    if (platform === 'devtools') return 'manual'
    // Avoid WeChat's SMS body length limit on Android.
    if (platform && platform !== 'android') return 'full'
  } catch (_) {}
  return 'number'
}

function smsFailure(error) {
  const reason = String((error && (error.errMsg || error.message)) || '')
  const code = error && (error.errCode ?? error.errno ?? error.code)
  // A platform error can echo the phone number or body. Only display technical text.
  const detail = reason.replace(/^sendSms:\s*/i, '').split(/[\r\n]/)[0]
  const bodyTooLong = /内容超出正文上限|(?:content|body).{0,30}(?:too long|exceeds?.{0,20}(?:length|limit))/i.test(detail)
  const safeDetail = bodyTooLong ? '内容超出正文上限' : /^[A-Za-z :_.-]{1,100}$/.test(detail) ? detail : ''
  const safeCode = /^-?\d{1,9}$/.test(String(code)) ? String(code) : ''
  const diagnostic = [safeDetail, safeCode].filter(Boolean).join(' · ') || '微信未提供详细原因'
  if (/cancel|用户取消/i.test(reason)) return { cancelled: true }
  if (/activitynotfound|no activity|no (?:default )?sms app|no application/i.test(reason)) {
    return { manual: true, diagnostic, hint: '手机找不到短信应用。请在系统设置中选择默认短信应用，再重试。' }
  }
  if (/denied|no permission|not authorized|unauthorized|无权限/i.test(reason)) {
    return { manual: true, diagnostic, hint: '当前微信未允许打开短信，请按下方步骤在手机短信中发送。' }
  }
  if (/not support|unsupported|not implemented|不支持/i.test(reason)) {
    return { manual: true, diagnostic, hint: '当前微信环境不支持直接打开短信。' }
  }
  return { diagnostic }
}

function canOpenChat() {
  return typeof wx.openChatTool === 'function' &&
    (typeof wx.canIUse !== 'function' || wx.canIUse('openChatTool'))
}

function discardChatDraft(token) {
  try {
    const draft = wx.getStorageSync(CHAT_DRAFT_KEY)
    if (draft && draft.token === token) wx.removeStorageSync(CHAT_DRAFT_KEY)
  } catch (_) {}
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
    if (this.hidden && this.smsAttempt) this.smsAttempt.opening = ''
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
  },

  clearDetails() {
    this.requestId = (this.requestId || 0) + 1
    this.details = null
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
      const preview = { loading: false, card, message: invitationText(card) }
      if (smsOnly) {
        const defaultMode = defaultSmsMode()
        const supported = defaultMode !== 'manual'
        if (!this.smsSession || this.smsSession.id !== id || this.smsSession.version !== details.version) {
          this.smsAttempt = null
          this.smsSession = { id, version: details.version, mode: '', diagnostic: '', hint: '' }
        }
        const session = this.smsSession
        this.setData({
          ...preview,
          phone: sms.phone || '', canCompose: supported,
          smsMode: supported ? session.mode || defaultMode : 'manual', smsDiagnostic: session.diagnostic, smsHint: session.hint,
          opening: this.smsAttempt ? this.smsAttempt.opening : '',
          shortSms: compactSms(card),
          cloudEnabled: sms.enabled && sms.status !== 'accepted' && sms.status !== 'pending',
          cloudStatus: sms.status || '', cloudNote: sms.reason || '',
          cloudFields: smsFields(card).join(' · '),
        })
        this.details = details
      } else {
        this.setData({ ...preview, canOpenChat: canOpenChat() })
      }
    } catch (error) {
      if (this.requestId === requestId) {
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

  openChat() {
    const { card, smsOnly, message, canOpenChat } = this.data
    if (!card || smsOnly || !message || !canOpenChat || this.chatRequest) return

    const createdAt = Date.now()
    const token = createdAt.toString(36) + '-' + Math.random().toString(36).slice(2)
    this.chatRequest = token
    this.setData({ chatOpening: true, chatNotice: '', copyStatus: '' })

    const finish = (chatNotice = '') => {
      if (this.chatRequest !== token) return
      this.chatRequest = null
      if (!this.unloaded) this.setData({ chatOpening: false, chatNotice })
    }
    const fail = error => {
      discardChatDraft(token)
      const cancelled = /cancel|取消/i.test((error && error.errMsg) || '')
      finish(cancelled
        ? '已取消选择。可复制预订消息后粘贴发送。'
        : '无法打开微信聊天列表，可复制预订消息后粘贴发送。')
    }

    try {
      wx.setStorageSync(CHAT_DRAFT_KEY, { token, text: message, createdAt })
      wx.openChatTool({
        url: '/chat-tool/pages/send/index?token=' + token,
        success: () => finish(),
        fail,
      })
    } catch (error) {
      fail(error)
    }
  },

  copyForNumberOnly(event) {
    const { smsMode, card, phone, opening, sending } = this.data
    if (!this.smsSession || smsMode !== 'full' || !card || !phone || opening || sending || this.clipboardRequest) return
    this.smsSession.mode = 'number'
    this.setData({ smsMode: 'number' })
    this.copy(event)
  },

  compose() {
    const { message, smsMode, smsCopied } = this.data
    if (smsMode === 'full') this.openSms('full', message)
    else if (smsCopied === 'message') this.openSms('number')
  },

  composeShort() {
    const { smsMode, shortSms } = this.data
    if (smsMode !== 'full' && shortSms?.message) this.openSms('short', shortSms.message)
  },

  openSms(mode, content) {
    const { card, smsOnly, phone, opening, sending, canCompose } = this.data
    const session = this.smsSession
    if (!session || !card || !smsOnly || !phone || !canCompose || opening || sending || this.clipboardRequest) return
    const attempt = { opening: mode }
    this.smsAttempt = attempt
    this.setData({ opening: mode, notice: '' })
    const finish = (failure, opened = false) => {
      if (this.smsAttempt !== attempt || this.smsSession !== session) return
      this.smsAttempt = null
      if (failure && !failure.cancelled) {
        if (failure.manual || mode === 'number') session.mode = 'manual'
        else if (mode === 'full') session.mode = 'number'
        session.diagnostic = failure.diagnostic
        session.hint = failure.hint || (mode === 'short' ? '未能打开精简短信，可复制完整正文发送。' : '')
      } else if (opened) {
        if (mode !== 'short') session.mode = mode
        session.diagnostic = ''
        session.hint = ''
      }
      if (!this.hidden && !this.unloaded && this.data.card) {
        this.setData({ opening: '', smsMode: session.mode || this.data.smsMode, smsDiagnostic: session.diagnostic, smsHint: session.hint })
      }
    }
    try {
      wx.sendSms({
        phoneNumber: phone, ...(content === undefined ? {} : { content }),
        success: () => finish(null, true),
        fail: error => finish(smsFailure(error)),
        complete: () => finish(),
      })
    } catch (error) {
      finish(smsFailure(error))
    }
  },

  copy(event) {
    const { card, smsOnly, phone, message, opening, sending } = this.data
    const field = smsOnly && event.currentTarget.dataset.field === 'phone' ? 'phone' : 'message'
    const text = field === 'phone' ? phone : message
    if (!card || !text || this.clipboardRequest || opening || sending) return

    const requestId = this.requestId
    const clipboardRequest = {}
    this.clipboardRequest = clipboardRequest
    this.setData({ copyStatus: 'copying', smsCopied: '', chatNotice: '' })
    const setStatus = copyStatus => {
      if (this.clipboardRequest !== clipboardRequest) return
      this.clipboardRequest = null
      if (this.requestId === requestId) {
        this.setData({ copyStatus, smsCopied: smsOnly && copyStatus === 'success' ? field : '' })
      }
    }
    try {
      wx.setClipboardData({
        data: text,
        success: () => setStatus('success'),
        fail: () => setStatus('failed'),
      })
    } catch (_) {
      setStatus('failed')
    }
  },

  sendCloud() {
    const { cloudEnabled, sending, opening, phone } = this.data
    const details = this.details
    if (!details || !cloudEnabled || sending || opening) return
    wx.showModal({
      title: '用门店短信发送',
      content: '将使用门店短信服务向 ' + phone + ' 发送本次预订通知。',
      confirmText: '确认发送',
      confirmColor: '#103947',
      success: result => { if (result.confirm) this.submitCloud(details) },
    })
  },

  async submitCloud(details) {
    const { id, cloudEnabled, sending, opening } = this.data
    if (this.details !== details || !cloudEnabled || sending || opening) return
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
