const api = require('../../lib/api')
const { invitationText, smsFields } = require('../../lib/invitation')

const CHAT_DRAFT_KEY = 'shh.chatTool.draft'
const EMPTY_DETAILS = {
  loading: true, error: '', needsName: false, notice: '', copyStatus: '',
  card: null, phone: '', message: '', canOpenChat: false, canCompose: false, opening: false,
  smsDiagnostic: '', smsHint: '',
  cloudEnabled: false, cloudStatus: '', cloudNote: '', cloudFields: '',
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
      const preview = { loading: false, card, message: invitationText(card) }
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
        this.setData({
          ...preview, canOpenChat: canOpenChat(),
          phone: sms?.phone || '',
          cloudEnabled: !details.trial && Boolean(sms?.enabled) && sms.status !== 'accepted' && sms.status !== 'pending',
          cloudStatus: details.trial ? '' : sms?.status || '',
          cloudNote: details.trial ? '' : sms?.reason || '',
          cloudFields: smsFields(card).join(' · '),
        })
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
    if (!card || smsOnly || !message || !canOpenChat || this.chatRequest || this.clipboardRequest || this.hidden || this.unloaded) return

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
      const cancelled = /cancel|取消/i.test(error?.errMsg || error?.message || '')
      finish(cancelled
        ? '已取消选择联系人。'
        : '无法打开微信联系人列表，可复制原文后粘贴发送。')
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
    if (!card || !message || this.clipboardRequest || this.chatRequest || opening || sending || this.hidden || this.unloaded) return

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
