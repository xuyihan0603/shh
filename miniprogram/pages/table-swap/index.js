const { call, today } = require('../../lib/api')
const { errorMessage, floorOptions, orderUrl, presentOrder, presentTables } = require('../../lib/reception')

function tableLabel(table) {
  return [table.floor, table.name].filter(Boolean).join(' ')
}

function addCapacity(first, second) {
  return first == null || second == null ? null : first + second
}

function describeMove(label, guests, from, to, capacity) {
  const capacityNote = capacity === null ? '，换桌后容量待补'
    : capacity < guests ? `，换桌后最多 ${capacity} 人` : ''
  return `${label} ${guests} 人${capacityNote}\n${tableLabel(from)} → ${tableLabel(to)}`
}

Page({
  data: {
    id: '',
    order: null,
    sourceTables: [],
    targetTables: [],
    floors: [],
    floor: '',
    sourceId: '',
    targetId: '',
    loading: true,
    error: '',
    needsName: false,
    actionError: '',
    submitting: false,
  },

  onLoad(query = {}) {
    this.setData({ id: query.id || '' })
    if (typeof wx.hideShareMenu === 'function') wx.hideShareMenu({})
  },

  onShow() {
    if (!this.data.submitting) return this.load()
  },

  onUnload() {
    this.unloaded = true
    this.optionsRequest = null
  },

  async onPullDownRefresh() {
    try {
      if (!this.data.submitting && !this.confirmationOpen) await this.load()
    } finally {
      wx.stopPullDownRefresh()
    }
  },

  async load() {
    const { id } = this.data
    if (!id) {
      this.setData({ loading: false, error: '缺少订单编号。' })
      return
    }
    const request = {}
    this.optionsRequest = request
    this.setData({ order: null, loading: true, needsName: false, error: '', actionError: '' })
    try {
      const { order, sourceTables, tables } = await call('tableSwapOptions', { id })
      if (this.optionsRequest !== request) return
      this.setData({
        order: presentOrder(order, today()),
        sourceTables: presentTables(sourceTables),
        targetTables: presentTables(tables),
        floors: floorOptions(tables),
        floor: '',
        sourceId: sourceTables.length === 1 ? sourceTables[0].id : '',
        targetId: '',
        loading: false,
      })
    } catch (error) {
      if (this.optionsRequest !== request) return
      this.setData({
        loading: false,
        needsName: error.code === 'NAME_REQUIRED',
        error: errorMessage(error, '换桌资料加载失败，请重试。'),
      })
    }
  },

  pickFloor(event) {
    if (this.data.submitting || this.confirmationOpen) return
    const floor = event.currentTarget.dataset.id
    if (floor !== this.data.floor) this.setData({ floor, targetId: '' })
  },

  pickSource(event) {
    if (this.data.submitting || this.confirmationOpen) return
    this.setData({ sourceId: event.currentTarget.dataset.id, actionError: '' })
  },

  pickTarget(event) {
    if (this.data.submitting || this.confirmationOpen) return
    this.setData({ targetId: event.currentTarget.dataset.id, actionError: '' })
  },

  confirmSwap() {
    const { order, sourceTables, targetTables, sourceId, targetId, loading, submitting } = this.data
    if (!order || loading || submitting || this.confirmationOpen) return
    const source = sourceTables.find(table => table.id === sourceId)
    const target = targetTables.find(table => table.id === targetId)
    if (!source || !target) return

    const sourceCapacity = sourceTables.filter(table => table.id !== source.id)
      .reduce((capacity, table) => addCapacity(capacity, table.capacity), target.capacity ?? null)
    const changes = [describeMove('本单', order.guests, source, target, sourceCapacity)]
    if (target.orderId) {
      const targetCapacity = addCapacity(source.capacity, target.otherTablesCapacity)
      changes.push(describeMove(`另一笔订单（${target.orderId}）`, target.orderGuests, target, source, targetCapacity))
    }
    const request = this.optionsRequest
    this.confirmationOpen = true
    wx.showModal({
      title: target.orderId ? '确认交换桌位' : '确认换到空桌',
      content: `${order.date} ${order.mealLabel}\n\n${changes.join('\n\n')}`,
      confirmText: target.orderId ? '确认交换' : '确认换桌',
      cancelText: '返回',
      confirmColor: '#103947',
      success: result => {
        if (result.confirm && this.optionsRequest === request) return this.swap(order, source, target)
      },
      complete: () => { this.confirmationOpen = false },
    })
  },

  async swap(order, source, target) {
    if (this.data.submitting || this.unloaded) return
    this.setData({ submitting: true, actionError: '' })
    try {
      await call('swapTables', {
        id: order.id,
        version: order.version,
        fromTableId: source.id,
        toTableId: target.id,
        ...(target.orderId ? { targetId: target.orderId, targetVersion: target.orderVersion } : {}),
      })
      if (this.unloaded) return
      this.swapped = true
      this.returnToOrder()
    } catch (error) {
      if (this.unloaded) return
      await this.load()
      if (!this.unloaded) {
        this.setData({ actionError: errorMessage(error, '换桌未完成，请核对桌位后重试。') })
      }
    } finally {
      if (!this.unloaded) this.setData({ submitting: false })
    }
  },

  returnToOrder() {
    const pages = getCurrentPages()
    const previous = pages[pages.length - 2]
    const { id } = this.data
    const success = this.swapped ? () => wx.showToast({ title: '换桌完成', icon: 'success' }) : undefined
    if (previous?.route === 'pages/order/index' && previous.data.id === id) {
      wx.navigateBack({ success })
    } else if (id) {
      wx.redirectTo({ url: orderUrl(id), success })
    }
  },

  openAccount() {
    wx.switchTab({ url: '/pages/account/index' })
  },
})
