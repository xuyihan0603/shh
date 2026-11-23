const api = require('../../lib/api')
const { serviceContactLine } = require('../../lib/invitation')

Page({
  data: { card: null, serviceContact: '', error: '' },

  onLoad(options = {}) {
    this.token = options.token
  },

  onShow() {
    this.load()
  },

  onUnload() {
    this.inviteRequest = null
  },

  async load() {
    const request = {}
    this.inviteRequest = request
    this.setData({ card: null, serviceContact: '', error: '' })
    try {
      if (!this.token) throw new Error('请从微信邀请卡片打开。')
      const card = await api.readInvite(this.token)
      if (this.inviteRequest === request) this.setData({ card, serviceContact: serviceContactLine(card) })
    } catch (error) {
      if (this.inviteRequest === request) this.setData({ error: error.message || '邀请函无法读取，请联系门店。' })
    }
  },

  contact(event) {
    const { card } = this.data
    if (!card) return
    const phone = event.currentTarget.dataset.contact === 'staff' ? card.servicePhone : card.phone
    if (phone) wx.makePhoneCall({ phoneNumber: phone })
  },
})
