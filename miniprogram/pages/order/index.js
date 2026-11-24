const { call, today } = require('../../lib/api')
const { dateLabel, presentOrder, formatMoney, readAmount, isPhone, errorMessage, bookingUrl } =
  require('../../lib/reception')

const ACTIONS = {
  arrive: { title: '确认到店', permission: 'canArrive', message: '确认客人已经到店？', success: '已登记到店' },
  cancel: { title: '取消订单', permission: 'canCancel', message: '取消后将释放该订单的全部桌位。', success: '订单已取消' },
  settle: { permission: 'canSettle', success: '金额已录入' },
}

function localLogTime(value) {
  const time = new Date(value).getTime()
  return Number.isFinite(time)
    ? new Date(time + 8 * 60 * 60 * 1000).toISOString().slice(0, 16).replace('T', ' ')
    : ''
}

Page({
  data: {
    id: '',
    order: null,
    customerProfile: null,
    loading: true,
    error: '',
    needsName: false,
    mutating: false,
    actionError: '',
    amountOpen: false,
    amountDraft: '',
  },

  onLoad(options = {}) {
    this.supplementAmount = options.supplementAmount === '1'
    this.setData({ id: options.id || '' })
  },

  onShow() {
    if (typeof wx.hideShareMenu === 'function') wx.hideShareMenu({})
    if (!this.data.mutating) return this.loadOrder()
  },

  onUnload() {
    this.unloaded = true
    this.orderRequest = (this.orderRequest || 0) + 1
  },

  async onPullDownRefresh() {
    try {
      if (!this.data.mutating) await this.loadOrder()
    } finally {
      wx.stopPullDownRefresh()
    }
  },

  async loadOrder() {
    const { id } = this.data
    if (!id) {
      this.setData({ loading: false, error: '缺少订单编号。' })
      return
    }
    const request = (this.orderRequest || 0) + 1
    this.orderRequest = request
    this.setData({ loading: true, order: null, customerProfile: null, error: '', needsName: false, actionError: '' })
    try {
      const order = await call('order', { id })
      if (request !== this.orderRequest) return
      this.showOrder(order)
      if (this.supplementAmount) {
        this.supplementAmount = false
        if (order.amount == null) this.openAmount()
      }
    } catch (error) {
      if (request !== this.orderRequest) return
      this.setData({
        loading: false,
        needsName: error.code === 'NAME_REQUIRED',
        error: errorMessage(error, '订单详情加载失败，请重试。'),
      })
    }
  },

  showOrder(order) {
    const currentDate = today()
    this.setData({
      customerProfile: null,
      order: {
        ...presentOrder(order, currentDate),
        createdDateLabel: dateLabel(order.createdDate, currentDate),
        amountLabel: order.status === 'cancelled' && order.amount === null ? '—' : formatMoney(order.amount),
        depositLabel: order.deposit > 0 ? formatMoney(order.deposit) : '未收订金',
        canDial: isPhone(order.phone),
        canNotify: order.kind === 'booking' && order.status === 'booked' && order.canEdit,
        tableSwapStaffName: order.tableSwapStaffName || order.ownerName || '原接单营销',
        logs: (order.logs || []).slice().reverse().map((log, index) => ({
          ...log, index, timeLabel: localLogTime(log.at),
        })),
      },
      loading: false,
      amountOpen: order.canSettle && this.data.amountOpen,
    })
    if (isPhone(order.phone)) this.loadCustomerProfile(order)
  },

  async loadCustomerProfile(order) {
    const request = this.orderRequest
    try {
      const customer = await call('customerLookup', { phone: order.phone })
      const visible = this.data.order
      if (this.orderRequest === request && visible && visible.id === order.id && visible.version === order.version && customer) {
        this.setData({ customerProfile: { visits: customer.visits, segment: customer.segment || null } })
      }
    } catch (_) {
      // The order remains usable while its optional customer history is unavailable.
    }
  },

  dial() {
    const { order } = this.data
    if (order && order.canDial) wx.makePhoneCall({ phoneNumber: order.phone })
  },

  edit() {
    const { order, mutating } = this.data
    if (order && order.canEdit && !mutating) wx.navigateTo({ url: bookingUrl('', '', { id: order.id }) })
  },

  openTableSwap() {
    const { order, mutating } = this.data
    if (order && order.canSwapTables && !mutating) {
      wx.navigateTo({ url: '/pages/table-swap/index?id=' + encodeURIComponent(order.id) })
    }
  },

  askTableSwapAuthorization() {
    const { order, mutating } = this.data
    if (!order || !order.canAuthorizeTableSwap || mutating || this.modalOpen) return
    const revoke = order.tableSwapAuthorized
    const staffName = order.tableSwapStaffName
    this.modalOpen = true
    wx.showModal({
      title: revoke ? '撤回换桌授权' : '授权换桌',
      content: revoke
        ? `撤回后，${staffName}需要重新获授权才能为这笔订单换桌。`
        : `允许${staffName}为 ${order.date} ${order.mealLabel} 的 ${order.tableLabel} 换桌一次？可换空桌，也可与同餐段的预订交换。`,
      confirmText: revoke ? '确认撤回' : '确认授权',
      cancelText: '返回',
      confirmColor: revoke ? '#a04636' : '#103947',
      success: result => {
        if (result.confirm && this.data.order === order) {
          return this.mutate('setTableSwapAuthorization', order, { staffId: revoke ? null : order.ownerId },
            revoke ? '已撤回授权' : '已授权换桌')
        }
      },
      complete: () => { this.modalOpen = false },
    })
  },

  openNotification(event) {
    const { order, mutating } = this.data
    const { channel } = event.currentTarget.dataset
    if (order && order.canNotify && !mutating) {
      wx.navigateTo({ url: '/pages/notify/index?id=' + encodeURIComponent(order.id) + '&channel=' + channel })
    }
  },

  askAction(event) {
    const action = event.currentTarget.dataset.action
    const config = ACTIONS[action]
    const { order, mutating } = this.data
    if (!config || !order || !order[config.permission] || mutating || this.modalOpen) return
    this.modalOpen = true
    wx.showModal({
      title: config.title,
      content: config.message,
      confirmText: action === 'cancel' ? '取消订单' : '确认到店',
      cancelText: '返回',
      confirmColor: action === 'cancel' ? '#a04636' : '#103947',
      success: result => {
        if (result.confirm) this.mutate(action, order)
      },
      complete: () => { this.modalOpen = false },
    })
  },

  openAmount() {
    const { order, mutating } = this.data
    if (!order || !order.canSettle || mutating) return
    this.setData({
      amountOpen: true,
      amountDraft: order.amount == null ? '' : String(order.amount),
      actionError: '',
    }, () => wx.pageScrollTo({ selector: '#order-payment', duration: 180 }))
  },

  closeAmount() {
    if (!this.data.mutating) this.setData({ amountOpen: false, actionError: '' })
  },

  changeAmount(event) {
    this.setData({ amountDraft: event.detail.value, actionError: '' })
  },

  saveAmount() {
    const { order, amountDraft, mutating } = this.data
    if (!order || !order.canSettle || mutating) return
    const amount = readAmount(amountDraft)
    if (amount === null) {
      this.setData({ actionError: '请输入非负金额，最多两位小数。' })
      return
    }
    return this.mutate('settle', order, { amount })
  },

  async mutate(action, order, extra = {}, success = ACTIONS[action].success) {
    if (this.data.mutating) return
    this.setData({ mutating: true, actionError: '' })
    try {
      const updated = await call(action, { id: order.id, version: order.version, ...extra })
      if (this.unloaded) return
      this.setData({ amountOpen: false })
      this.showOrder(updated)
      wx.showToast({ title: success, icon: 'success' })
    } catch (error) {
      if (this.unloaded) return
      const stale = error.code === 'VERSION_CONFLICT'
      if (stale || action === 'setTableSwapAuthorization') await this.loadOrder()
      if (this.unloaded) return
      const actionError = stale ? '订单已更新，请核对最新记录后再操作。' : errorMessage(error, '操作未完成，请重试。')
      this.setData({ actionError })
      if (action !== 'settle') wx.showToast({ title: actionError, icon: 'none' })
    } finally {
      if (!this.unloaded) this.setData({ mutating: false })
    }
  },

  openAccount() {
    wx.switchTab({ url: '/pages/account/index' })
  },
})
