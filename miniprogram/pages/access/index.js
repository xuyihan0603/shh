const api = require('../../lib/api')
const { staffCode } = require('../../lib/reception')

Page({
  data: {
    checking: true, busy: false, me: null, storeName: '', code: '',
    name: '', canBindAdmin: false, showAdmin: false, password: '', error: '',
  },

  onShow() { return this.refresh() },

  onHide() {
    this.requestId = (this.requestId || 0) + 1
    this.setData({ password: '' })
  },

  onUnload() { this.requestId = (this.requestId || 0) + 1 },

  async refresh() {
    if (this.data.busy) return
    const requestId = (this.requestId || 0) + 1
    this.requestId = requestId
    this.setData({ checking: true, error: '' })
    try {
      const { me, store, nameSuggestion, canBindAdmin } = await api.call('bootstrap')
      if (requestId !== this.requestId) return
      if (me.role !== 'pending') {
        wx.switchTab({ url: me.nameBound ? '/pages/index/index' : '/pages/account/index' })
        return
      }
      this.setData({
        me, storeName: store?.name || '珊瑚海', code: staffCode(me.id),
        name: me.nameBound ? me.name : this.data.name || nameSuggestion || '',
        canBindAdmin: Boolean(canBindAdmin),
        showAdmin: Boolean(canBindAdmin && this.data.showAdmin),
      })
    } catch (error) {
      if (requestId === this.requestId) this.setData({ error: error.message })
    } finally {
      if (requestId === this.requestId) this.setData({ checking: false })
    }
  },

  field(event) { this.setData({ [event.currentTarget.dataset.name]: event.detail.value }) },

  async saveName() {
    const { checking, busy, me, name } = this.data
    if (checking || busy || !me || me.nameBound || !name.trim()) return
    this.setData({ busy: true, error: '' })
    try {
      const updated = await api.bindStaffName(name.trim())
      this.setData({ me: updated, name: updated.name })
      if (updated.role !== 'pending') wx.switchTab({ url: '/pages/index/index' })
    } catch (error) {
      this.setData({ error: error.message })
    } finally {
      this.setData({ busy: false })
    }
  },

  toggleAdmin() {
    if (this.data.canBindAdmin && !this.data.busy) {
      this.setData({ showAdmin: !this.data.showAdmin, password: '', error: '' })
    }
  },

  async bindAdmin() {
    const { checking, busy, canBindAdmin, showAdmin, password } = this.data
    if (checking || busy || !canBindAdmin || !showAdmin || !password) return
    this.setData({ busy: true, error: '' })
    try {
      await api.bindAdmin(password)
      this.setData({ canBindAdmin: false, showAdmin: false })
      wx.switchTab({ url: '/pages/account/index' })
    } catch (error) {
      this.setData({
        error: error.message,
        ...(error.code === 'ADMIN_BOUND' ? { canBindAdmin: false, showAdmin: false } : {}),
      })
    } finally {
      this.setData({ busy: false, password: '' })
    }
  },
})
