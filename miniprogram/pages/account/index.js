const api = require('../../lib/api')
const { ROLES, canBook } = require('../../lib/reception')

Page({
  data: { name: '', servicePhone: '', bookingStaff: false, loading: true, busy: false, error: '', me: null, store: null },

  onShow() { return this.refresh() },
  onHide() { this.requestId = (this.requestId || 0) + 1 },
  onUnload() { this.onHide() },

  async refresh() {
    if (this.data.busy) return
    const requestId = (this.requestId || 0) + 1
    this.requestId = requestId
    this.setData({ loading: true, error: '', me: null, store: null })
    try {
      const { me, store, nameSuggestion } = await api.call('bootstrap')
      if (requestId !== this.requestId) return
      if (me.role === 'pending') return api.openAccess()
      this.setData({
        me, store, name: me.nameBound ? me.name : nameSuggestion || '',
        servicePhone: me.servicePhone || '', bookingStaff: canBook(me.role), role: ROLES[me.role],
      })
    } catch (error) {
      if (requestId === this.requestId) this.setData({ error: error.message })
    } finally {
      if (requestId === this.requestId) this.setData({ loading: false })
    }
  },

  field(event) { this.setData({ [event.currentTarget.dataset.name]: event.detail.value }) },

  async saveProfile() {
    const { me, name, servicePhone, bookingStaff, busy } = this.data
    if (busy || !me) return
    const binding = !me.nameBound
    this.setData({ busy: true, error: '' })
    try {
      const updated = binding
        ? await api.bindStaffName(name, bookingStaff ? servicePhone : undefined)
        : await api.setServicePhone(servicePhone)
      if (updated.role === 'pending') return api.openAccess()
      this.setData({ me: updated, name: updated.name, servicePhone: updated.servicePhone || '' })
      if (binding) wx.switchTab({ url: '/pages/index/index' })
      else wx.showToast({ title: '手机号已保存' })
    } catch (error) {
      this.setData({ error: error.message })
    } finally {
      this.setData({ busy: false })
    }
  },

  openStaffRoles() {
    const { me, busy } = this.data
    if (!busy && me?.nameBound && me.role === 'admin') wx.navigateTo({ url: '/pages/staff/index' })
  },
})
