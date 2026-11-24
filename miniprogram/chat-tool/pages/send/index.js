const DRAFT_KEY = 'shh.chatTool.draft'
const DRAFT_MAX_AGE = 10 * 60 * 1000

Page({
  data: {
    statusBarHeight: 0, text: '', hasText: false, submitted: false,
    storefrontImagePath: '', canShareImage: false, sharingImage: false, imageNotice: '',
    storeLocation: null, canOpenLocation: false, locationNotice: '',
  },

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
        const { text } = draft
        const storefrontImagePath = typeof draft.storefrontImagePath === 'string' ? draft.storefrontImagePath : ''
        const storeLocation = typeof draft.storeLocation?.name === 'string' && draft.storeLocation.name.trim()
          ? draft.storeLocation : null
        const { latitude, longitude } = storeLocation || {}
        const canOpenLocation = typeof wx.openLocation === 'function' &&
          Number.isFinite(latitude) && Math.abs(latitude) <= 90 &&
          Number.isFinite(longitude) && Math.abs(longitude) <= 180
        this.setData({
          text, hasText: !!text.trim(),
          storefrontImagePath, canShareImage: typeof wx.shareImageToGroup === 'function',
          storeLocation, canOpenLocation,
        })
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

  shareStorefront() {
    const { storefrontImagePath, canShareImage, sharingImage } = this.data
    if (!storefrontImagePath || !canShareImage || sharingImage) return

    this.setData({ sharingImage: true, imageNotice: '' })
    const finish = imageNotice => this.setData({ sharingImage: false, imageNotice })
    const fail = error => {
      const cancelled = /cancel|取消/i.test(error?.errMsg || '')
      finish(cancelled ? '已取消发送门头照片。' : '门头照片未能发起发送，请重试。')
    }
    try {
      wx.shareImageToGroup({
        imagePath: storefrontImagePath,
        needShowEntrance: false,
        success: () => finish('请在微信聊天中查看照片发送结果。'),
        fail,
      })
    } catch (error) {
      fail(error)
    }
  },

  copyStoreName() {
    const name = this.data.storeLocation?.name
    if (!name) return

    const fail = () => this.setData({ locationNotice: '店名复制失败，可长按店名手动复制。' })
    try {
      wx.setClipboardData({
        data: name,
        success: () => this.setData({ locationNotice: '已复制店名，可在微信位置页粘贴搜索。' }),
        fail,
      })
    } catch {
      fail()
    }
  },

  openStoreLocation() {
    const { storeLocation, canOpenLocation } = this.data
    if (!canOpenLocation) return

    this.setData({ locationNotice: '' })
    wx.openLocation({
      ...storeLocation,
      fail: () => this.setData({ locationNotice: '地图暂时无法打开，可复制店名后在微信中搜索。' }),
    })
  },

  goBack() {
    wx.navigateBack({ fail: () => wx.exitMiniProgram() })
  }
})
