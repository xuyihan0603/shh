const DRAFT_KEY = 'shh.chatTool.draft'
const DRAFT_MAX_AGE = 10 * 60 * 1000

function isFresh(createdAt) {
  const now = Date.now()
  return Number.isFinite(createdAt) && createdAt <= now && now - createdAt < DRAFT_MAX_AGE
}

function readInvitation(token) {
  try {
    const draft = wx.getStorageSync(DRAFT_KEY)
    if (!draft) return null

    const fresh = isFresh(draft.createdAt)
    const matched = typeof token === 'string' && /^[a-z0-9_-]+$/i.test(token) && token === draft.token
    if (!fresh || matched) wx.removeStorageSync(DRAFT_KEY)
    if (!fresh || !matched) return null

    const folder = wx.env?.USER_DATA_PATH
    const { invitationImagePath, createdAt } = draft
    // Only the file named for this handoff belongs to the chat tool.
    if (!folder || invitationImagePath !== `${folder}/shh-invite-${token}.jpg`) return null
    return { invitationImagePath, createdAt }
  } catch {
    return null
  }
}

Page({
  data: {
    statusBarHeight: 0,
    invitationImagePath: '', canShareImage: false, shareState: '', shareNotice: '',
  },

  onLoad({ token } = {}) {
    this.invitation = readInvitation(token)
    const invitationImagePath = this.invitation?.invitationImagePath || ''
    const canShareImage = Boolean(invitationImagePath) && typeof wx.shareImageToGroup === 'function' &&
      (typeof wx.canIUse !== 'function' || wx.canIUse('shareImageToGroup'))
    let shareNotice = ''
    if (!invitationImagePath) {
      shareNotice = '当前没有可发送的预订图，请返回预订消息页重新生成。'
    } else if (!canShareImage) {
      shareNotice = '当前微信无法在这里发送图片，请返回预订消息页转发。'
    }
    this.setData({
      statusBarHeight: wx.getWindowInfo?.().statusBarHeight || 0,
      invitationImagePath, canShareImage, shareNotice,
    })
  },

  onShow() {
    if (this.data.invitationImagePath && !this.shareAttempt) this.expireImage()
  },

  onUnload() {
    this.unloaded = true
    // A pending native share can still be reading the file.
    if (!this.shareAttempt) this.removeInvitationFile()
  },

  removeInvitationFile() {
    const path = this.invitation?.invitationImagePath
    this.invitation = null
    if (!path) return
    try {
      wx.getFileSystemManager().unlinkSync(path)
    } catch {}
  },

  expireImage() {
    if (isFresh(this.invitation?.createdAt)) return false
    this.setData({
      invitationImagePath: '', canShareImage: false,
      shareNotice: '预订图已过期，请返回预订消息页重新生成。',
    })
    return true
  },

  onImageError() {
    this.setData({
      invitationImagePath: '', canShareImage: false,
      shareNotice: '预订图无法打开，请返回预订消息页重新生成。',
    })
  },

  shareInvitation() {
    const { invitationImagePath, canShareImage, shareState } = this.data
    if (this.unloaded || !canShareImage || this.shareAttempt || shareState === 'requested') return
    if (this.expireImage()) return

    const attempt = {}
    this.shareAttempt = attempt
    this.setData({ shareState: 'sharing', shareNotice: '' })
    const finish = (shareState, shareNotice) => {
      if (this.shareAttempt !== attempt) return
      this.shareAttempt = null
      if (this.unloaded) {
        this.removeInvitationFile()
      } else {
        this.setData({ shareState, shareNotice })
      }
    }
    const fail = error => {
      const cancelled = /cancel|取消/i.test(error?.errMsg || error?.message || '')
      finish('', cancelled
        ? '已取消发送，可以重试。'
        : '未能发起发送，可重试或返回预订消息页转发图片。')
    }
    try {
      wx.shareImageToGroup({
        imagePath: invitationImagePath,
        needShowEntrance: false,
        success: () => finish('requested', '请在微信聊天中查看发送结果。'),
        fail,
      })
    } catch (error) {
      fail(error)
    }
  },

  goBack() {
    wx.navigateBack({ fail: () => wx.exitMiniProgram() })
  },
})
