const DRAFT_KEY = 'shh.chatTool.draft'
const DRAFT_MAX_AGE = 10 * 60 * 1000

function isFresh(createdAt) {
  const now = Date.now()
  return Number.isFinite(createdAt) && createdAt <= now && now - createdAt < DRAFT_MAX_AGE
}

function takeDraft(token) {
  try {
    const draft = wx.getStorageSync(DRAFT_KEY)
    if (!draft) return null

    const fresh = isFresh(draft.createdAt)
    const matched = typeof token === 'string' && /^[a-z0-9_-]+$/i.test(token) && token === draft.token
    if (!fresh || matched) wx.removeStorageSync(DRAFT_KEY)
    return fresh && matched && typeof draft.text === 'string' && draft.text.trim() ? draft : null
  } catch {
    return null
  }
}

Page({
  data: { statusBarHeight: 0, text: '', hasDraft: false, hasText: false, submitted: false, notice: '' },

  onLoad({ token } = {}) {
    const draft = takeDraft(token)
    this.createdAt = draft?.createdAt
    this.setData({
      statusBarHeight: wx.getWindowInfo?.().statusBarHeight || 0,
      text: draft?.text || '',
      hasDraft: Boolean(draft), hasText: Boolean(draft),
      notice: draft ? '' : '当前没有可发送的预订正文，请返回预订页重试。',
    })
  },

  onShow() {
    if (this.data.hasDraft && !isFresh(this.createdAt)) {
      this.setData({ text: '', hasDraft: false, hasText: false, notice: '预订正文已过期，请返回预订页重试。' })
    }
  },

  onInput(event) {
    if (!this.data.hasDraft) return
    const text = event.detail.value
    this.setData({ text, hasText: Boolean(text.trim()), submitted: false, notice: '' })
  },

  onSubmitToGroup(event) {
    if (!this.data.hasText || this.data.submitted) return
    const result = event?.detail?.errMsg || ''
    if (/cancel|取消/i.test(result)) {
      this.setData({ notice: '已取消发送，可重试。' })
    } else if (result && result !== 'submitToGroup:ok') {
      this.setData({ notice: '未能发起发送，可重试或返回预订页复制原文。' })
    } else {
      this.setData({ submitted: true, notice: '请在微信聊天中查看发送结果。' })
    }
  },

  goBack() {
    wx.navigateBack({ fail: () => wx.exitMiniProgram() })
  },
})
