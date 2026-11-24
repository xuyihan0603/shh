const { call, today, openAccess } = require('../../lib/api')
const {
  ROLES, TYPES, currentMeal, shiftDate, dateLabel, canBook, canManageOrders, presentTables,
  floorOptions, errorMessage, orderUrl, bookingUrl,
} = require('../../lib/reception')

Page({
  data: {
    storeName: '门店桌态',
    roleLabel: '',
    today: '',
    date: '',
    dateLabel: '',
    meal: 'lunch',
    canCreate: false,
    canRegister: false,
    contextReady: false,
    floors: [],
    floor: '',
    types: TYPES,
    type: '',
    tables: [],
    visibleTables: [],
    selectedIds: [],
    selectedLabel: '',
    guestCount: 0,
    availableCount: 0,
    occupiedCount: 0,
    loading: true,
    error: '',
    needsName: false,
  },

  onLoad() {
    const date = today()
    this.setData({ today: date, date, dateLabel: dateLabel(date, date), meal: currentMeal() })
  },

  onShow() {
    this.refresh()
  },

  onHide() {
    this.contextRequest = (this.contextRequest || 0) + 1
    this.boardRequest = (this.boardRequest || 0) + 1
  },

  async onPullDownRefresh() {
    try {
      await this.refresh()
    } finally {
      wx.stopPullDownRefresh()
    }
  },

  async refresh() {
    const request = (this.contextRequest || 0) + 1
    this.contextRequest = request
    this.boardRequest = (this.boardRequest || 0) + 1
    this.setData({ loading: true, error: '', needsName: false, contextReady: false, canCreate: false, canRegister: false })
    try {
      const { store, me } = await call('bootstrap')
      if (this.contextRequest !== request) return
      if (me.role === 'pending') return openAccess()
      if (me.nameBound === false) {
        this.setData({
          needsName: true, loading: false, error: '请先填写员工姓名，后续预订会自动记录到你的账号。',
          storeName: store.name, roleLabel: ROLES[me.role],
        })
        if (this.promptedAccount !== me.id) {
          this.promptedAccount = me.id
          this.openAccount()
        }
        return
      }
      this.promptedAccount = null
      const currentDate = today()
      this.setData({
        storeName: store.name,
        roleLabel: ROLES[me.role] || '',
        today: currentDate,
        dateLabel: dateLabel(this.data.date, currentDate),
        canCreate: canBook(me.role),
        canRegister: canManageOrders(me.role),
        contextReady: true,
      })
      await this.loadBoard()
    } catch (error) {
      if (this.contextRequest !== request) return
      this.setData({
        loading: false,
        error: errorMessage(error, '门店信息加载失败，请重试。'),
      })
    }
  },

  async loadBoard() {
    const request = (this.boardRequest || 0) + 1
    this.boardRequest = request
    const { date, meal } = this.data
    this.setData({ loading: true, error: '' })
    try {
      const board = await call('board', { date, meal })
      if (request !== this.boardRequest) return
      const tables = presentTables(board.tables)
      const availableCount = tables.filter(table => table.available).length
      const floors = floorOptions(tables)
      const floor = floors.some(option => option.id === this.data.floor) ? this.data.floor : ''
      const types = tables.some(table => table.type === 'unknown') ? TYPES.concat({ id: 'unknown', label: '待确认' }) : TYPES
      const type = types.some(option => option.id === this.data.type) ? this.data.type : ''
      this.setData({
        tables, floors, floor, types, type,
        guestCount: board.guestCount,
        availableCount,
        occupiedCount: tables.length - availableCount,
        loading: false,
      })
      const selected = this.data.canCreate
        ? this.data.selectedIds.filter(id => tables.some(table => table.id === id && table.available))
        : []
      this.showTables(selected)
    } catch (error) {
      if (request !== this.boardRequest) return
      this.setData({
        loading: false,
        needsName: error.code === 'NAME_REQUIRED',
        error: errorMessage(error, '桌态加载失败，请重试。'),
      })
    }
  },

  showTables(selectedIds = this.data.selectedIds) {
    const { tables, floor, type } = this.data
    const visibleTables = tables
      .filter(table => (!floor || table.floor === floor) && (!type || table.type === type))
      .map(table => ({ ...table, selected: selectedIds.includes(table.id) }))
    const selectedLabel = tables.filter(table => selectedIds.includes(table.id)).map(table => table.name).join('、')
    this.setData({ visibleTables, selectedIds, selectedLabel })
  },

  changeScope(date, meal) {
    if (date === this.data.date && meal === this.data.meal) return
    this.setData({ date, meal, dateLabel: dateLabel(date, this.data.today), selectedIds: [], selectedLabel: '' })
    if (this.data.contextReady) this.loadBoard()
  },

  pickDate(event) {
    this.changeScope(event.detail.value, this.data.meal)
  },

  stepDate(event) {
    this.changeScope(shiftDate(this.data.date, Number(event.currentTarget.dataset.days)), this.data.meal)
  },

  resetDate() {
    this.changeScope(this.data.today, this.data.meal)
  },

  pickMeal(event) {
    this.changeScope(this.data.date, event.currentTarget.dataset.meal)
  },

  pickFloor(event) {
    this.setData({ floor: event.currentTarget.dataset.id || '' })
    this.showTables()
  },

  pickType(event) {
    this.setData({ type: event.currentTarget.dataset.id || '' })
    this.showTables()
  },

  tapTable(event) {
    if (this.data.loading || this.data.error) return
    const table = this.data.tables.find(item => item.id === event.currentTarget.dataset.id)
    if (!table) return
    if (table.orderId) {
      wx.navigateTo({ url: orderUrl(table.orderId) })
      return
    }
    if (!this.data.canCreate) return
    const { selectedIds } = this.data
    this.showTables(selectedIds.includes(table.id) ? selectedIds.filter(id => id !== table.id) : selectedIds.concat(table.id))
  },

  clearSelection() {
    this.showTables([])
  },

  openBooking(event) {
    const { canCreate, canRegister, date, meal, selectedIds, loading, error } = this.data
    const kind = event.currentTarget.dataset.kind
    if (!canCreate || loading || error || (kind === 'walkin' && (!canRegister || date !== today()))) return
    wx.navigateTo({
      url: bookingUrl(date, meal, { kind, tableIds: selectedIds }),
      events: { saved: () => this.clearSelection() },
    })
  },

  openAccount() {
    wx.switchTab({ url: '/pages/account/index' })
  },
})
