const DRAFT_KEY = 'shh.chatTool.draft'
const DRAFT_MAX_AGE = 10 * 60 * 1000

Page({
  data: { statusBarHeight: 0, text: '', hasText: false, submitted: false },

  onLoad({ token } = {}) {
    this.setData({ statusBarHeight: wx.getWindowInfo().statusBarHeight || 0 })
    try {
      const draft = wx.getStorageSync(DRAFT_KEY)
      if (!draft) return
      const now = Date.now()
      const fresh = Number.isFinite(draft.createdAt) &&
        draft.createdAt <= now && now - draft.createdAt < DRAFT_MAX_AGE
      const matched = !!token && token === draft.token
      if (!fresh || matched) wx.removeStorageSync(DRAFT_KEY)
      if (fresh && matched && typeof draft.text === 'string') {
        this.setData({ text: draft.text, hasText: !!draft.text.trim() })
      }
    } catch {
      // If the local draft is unavailable, the text can still be entered here.
    }
  },

  onInput(event) {
    const text = event.detail.value
    this.setData({ text, hasText: !!text.trim(), submitted: false })
  },

  onSubmitToGroup() {
    this.setData({ submitted: true })
  },

  goBack() {
    wx.navigateBack({ fail: () => wx.exitMiniProgram() })
  }
})
