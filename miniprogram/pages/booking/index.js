const { call, today, openAccess } = require('../../lib/api')
const {
  MEALS, currentMeal, dateLabel, canBook, canWalkIn, presentTables, floorOptions,
  errorMessage, orderUrl, phoneInput, isPhone, readAmount,
} = require('../../lib/reception')

Page({
  data: {
    orderId: '',
    version: null,
    editing: false,
    isWalkIn: false,
    form: {
      date: '', meal: 'lunch', time: '', tableIds: [], guests: '', contact: '', phone: '',
      notes: '', kind: 'booking', deposit: '', depositMethod: '', depositHandler: '',
    },
    customer: null,
    dateLabel: '',
    timeDefault: '12:00',
    showTables: true,
    showDeposit: false,
    tables: [],
    visibleTables: [],
    floors: [],
    floor: '',
    selectedNames: '',
    selectedCapacity: 0,
    missingCapacity: false,
    contextLoading: true,
    contextError: '',
    forbidden: false,
    needsName: false,
    bookingStaffName: '',
    boardLoading: true,
    boardError: '',
    tableConflict: '',
    formError: '',
    staleVersion: false,
    saving: false,
  },

  onLoad(options = {}) {
    const currentDate = today()
    const isWalkIn = options.kind === 'walkin'
    const requestedDate = options.date || ''
    const validDate = /^\d{4}-\d{2}-\d{2}$/.test(requestedDate) &&
      Number.isFinite(new Date(requestedDate + 'T00:00:00Z').getTime())
    const date = !isWalkIn && validDate ? requestedDate : currentDate
    const meal = MEALS[options.meal] ? options.meal : currentMeal()
    const tableIds = this.readTableIds(options.tables)
    const orderId = options.id || ''
    this.setData({
      orderId, editing: Boolean(orderId), isWalkIn,
      form: { ...this.data.form, date, meal, tableIds, kind: isWalkIn ? 'walkin' : 'booking' },
      dateLabel: dateLabel(date, currentDate),
      timeDefault: meal === 'dinner' ? '18:00' : '12:00',
      showTables: !tableIds.length,
    })
    const channel = this.getOpenerEventChannel()
    if (!orderId && channel && channel.on) {
      channel.on('customer', ({ phone }) => {
        if (this.data.form.phone || this.phoneEdited || this.pageUnloaded) return
        this.setData({ 'form.phone': phone || '' })
        this.lookupCustomer()
      })
    }
    this.loadContext()
  },

  onUnload() {
    clearTimeout(this.customerTimer)
    this.customerLookup = null
    this.pageUnloaded = true
  },

  readTableIds(value) {
    if (!value) return []
    try {
      const ids = JSON.parse(value.startsWith('[') ? value : decodeURIComponent(value))
      return Array.isArray(ids) ? [...new Set(ids.filter(id => typeof id === 'string'))] : []
    } catch (_) {
      return []
    }
  },

  async loadContext() {
    this.setData({ contextLoading: true, contextError: '', needsName: false })
    try {
      const { orderId } = this.data
      const [{ me }, order] = await Promise.all([
        call('bootstrap'),
        orderId ? call('order', { id: orderId }) : Promise.resolve(null),
      ])
      if (this.pageUnloaded) return
      if (me.role === 'pending') return openAccess()
      const isWalkIn = order ? order.kind === 'walkin' : this.data.isWalkIn
      if (me.nameBound === false) {
        this.setData({ contextLoading: false, needsName: true, contextError: '首次接单前，请先填写员工姓名。' })
        return
      }
      const enabled = isWalkIn ? canWalkIn(me.role) : canBook(me.role)
      if (!enabled || (order && !order.canEdit)) {
        this.setData({
          contextLoading: false, forbidden: true,
          contextError: order ? '当前无法编辑这笔订单。' : '当前岗位无法登记订单。',
        })
        return
      }
      if (order) {
        const {
          date, meal, time, tableIds, guests, contact, phone, notes, kind,
          deposit, depositMethod, depositHandler,
        } = order
        this.setData({
          isWalkIn, version: order.version, showTables: false, showDeposit: Boolean(deposit),
          dateLabel: dateLabel(date, today()),
          timeDefault: meal === 'dinner' ? '18:00' : '12:00',
          form: {
            date, meal, time, tableIds, guests: String(guests), contact, phone, notes, kind,
            deposit: deposit ? String(deposit) : '', depositMethod, depositHandler: depositHandler || me.name,
          },
        })
      } else {
        this.setData({ 'form.depositHandler': me.name })
      }
      wx.setNavigationBarTitle({ title: order ? '编辑订单' : (isWalkIn ? '散客到店' : '新建预订') })
      this.setData({ contextLoading: false, forbidden: false, bookingStaffName: order ? order.ownerName : me.name })
      this.lookupCustomer()
      await this.loadBoard()
    } catch (error) {
      if (this.pageUnloaded) return
      this.setData({
        contextLoading: false,
        needsName: error.code === 'NAME_REQUIRED',
        contextError: errorMessage(error, '预订资料加载失败，请重试。'),
      })
    }
  },

  async loadBoard() {
    const request = (this.boardRequest || 0) + 1
    this.boardRequest = request
    const { date, meal } = this.data.form
    this.setData({ boardLoading: true, boardError: '' })
    try {
      const { tables: boardTables } = await call('board', { date, meal })
      if (request !== this.boardRequest) return
      const tables = presentTables(boardTables, this.data.orderId)
      const chosen = this.data.form.tableIds
      const available = chosen.filter(id => tables.some(table => table.id === id && table.available))
      const removed = chosen.filter(id => !available.includes(id))
      const floors = floorOptions(tables)
      const floor = floors.some(option => option.id === this.data.floor) ? this.data.floor : ''
      this.setData({ tables, floors, floor, boardLoading: false })
      if (removed.length) {
        const names = tables.filter(table => removed.includes(table.id)).map(table => table.name)
        this.setData({
          tableConflict: names.length ? names.join('、') + ' 已被占用，请重新选桌。' : '有桌位已不可选，请重新选桌。',
          showTables: true,
        })
      }
      this.showSelection(available)
    } catch (error) {
      if (request !== this.boardRequest) return
      this.setData({ showTables: true, boardLoading: false, boardError: errorMessage(error, '桌态加载失败，请重试。') })
    }
  },

  showSelection(tableIds = this.data.form.tableIds) {
    const { tables, floor } = this.data
    const visibleTables = tables
      .filter(table => !floor || table.floor === floor)
      .map(table => ({ ...table, selected: tableIds.includes(table.id) }))
    const selected = tables.filter(table => tableIds.includes(table.id))
    this.setData({
      visibleTables,
      'form.tableIds': tableIds,
      selectedNames: selected.map(table => table.name).join('、'),
      selectedCapacity: selected.reduce((count, table) => count + (table.capacity || 0), 0),
      missingCapacity: selected.some(table => table.capacity == null),
    })
  },

  changeScope(date, meal) {
    if (this.data.saving || (date === this.data.form.date && meal === this.data.form.meal)) return
    this.setData({
      'form.date': date, 'form.meal': meal, dateLabel: dateLabel(date, today()),
      timeDefault: meal === 'dinner' ? '18:00' : '12:00', tableConflict: '', formError: '',
    })
    this.loadBoard()
  },

  pickDate(event) {
    if (!this.data.isWalkIn) this.changeScope(event.detail.value, this.data.form.meal)
  },

  pickMeal(event) {
    this.changeScope(this.data.form.date, event.currentTarget.dataset.meal)
  },

  pickTime(event) {
    if (!this.data.saving) this.setData({ 'form.time': event.detail.value, formError: '' })
  },

  pickFloor(event) {
    this.setData({ floor: event.currentTarget.dataset.id || '' })
    this.showSelection()
  },

  selectTable(event) {
    if (this.data.saving || this.data.boardLoading || this.data.boardError) return
    const table = this.data.tables.find(item => item.id === event.currentTarget.dataset.id)
    if (!table || !table.available) return
    const { tableIds } = this.data.form
    this.setData({ tableConflict: '', formError: '' })
    this.showSelection(tableIds.includes(table.id) ? tableIds.filter(id => id !== table.id) : tableIds.concat(table.id))
  },

  toggleTables() {
    this.setData({ showTables: !this.data.showTables })
  },

  toggleDeposit() {
    this.setData({ showDeposit: !this.data.showDeposit })
  },

  changeField(event) {
    if (this.data.saving) return
    const { field } = event.currentTarget.dataset
    if (field === 'contact') {
      this.contactEdited = true
      this.autoFilledContact = false
    }
    this.setData({ ['form.' + field]: event.detail.value, formError: '' })
  },

  changePhone(event) {
    const phone = event.detail.value
    if (this.data.saving || phone === this.data.form.phone) return
    clearTimeout(this.customerTimer)
    this.customerLookup = null
    this.phoneEdited = true
    this.setData({
      'form.phone': phone, customer: null, formError: '',
      ...(this.autoFilledContact ? { 'form.contact': '' } : {}),
    })
    this.autoFilledContact = false
    if (/^(?:(?:\+|00)?86)?1[3-9]\d{9}$/.test(phoneInput(phone))) {
      this.customerTimer = setTimeout(() => this.lookupCustomer(), 250)
    }
  },

  lookupCustomer() {
    clearTimeout(this.customerTimer)
    const { form, contextLoading, contextError, saving } = this.data
    const phone = phoneInput(form.phone)
    if (contextLoading || contextError || saving || this.pageUnloaded || !isPhone(phone)) return
    if (this.customerLookup && this.customerLookup.phone === phone) return this.customerLookup.result
    const lookup = { phone }
    this.customerLookup = lookup
    lookup.result = call('customerLookup', { phone }).then(customer => {
      if (this.customerLookup !== lookup || phoneInput(this.data.form.phone) !== phone) return
      const contact = customer && customer.contact
      const fill = contact && !(this.data.form.contact || '').trim() && !this.contactEdited
      this.autoFilledContact = Boolean(fill)
      this.setData({ customer, ...(fill ? { 'form.contact': contact } : {}) })
    }).catch(() => {
      if (this.customerLookup === lookup) this.customerLookup = null
    })
    return lookup.result
  },

  fieldError(message) {
    this.setData({ formError: message })
    wx.showToast({ title: message, icon: 'none' })
  },

  revealTables() {
    this.setData({ showTables: true }, () => {
      wx.pageScrollTo({ selector: '#booking-tables', duration: 180 })
    })
  },

  async save() {
    const { form, orderId, version, saving, boardLoading, boardError, staleVersion, contextError } = this.data
    if (saving || boardLoading || boardError || staleVersion || contextError) return
    const { date, meal, time, tableIds, kind } = form
    if (!tableIds.length) {
      this.revealTables()
      this.fieldError('请至少选择一张桌。')
      return
    }
    const guests = Number(String(form.guests).trim())
    if (!/^\d+$/.test(String(form.guests).trim()) || !Number.isSafeInteger(guests) || guests < 1) {
      this.fieldError('请输入用餐人数。')
      return
    }
    const phone = phoneInput(form.phone)
    if (kind === 'booking' && (!time || !phone)) {
      this.fieldError(!time ? '请选择到店时间。' : '请输入联系电话。')
      return
    }
    if (phone && !isPhone(phone)) {
      this.fieldError('请输入正确的联系电话。')
      return
    }
    const deposit = readAmount(String(form.deposit || '').trim() || '0')
    const depositMethod = (form.depositMethod || '').trim()
    if (deposit === null || (deposit > 0 && !depositMethod)) {
      this.setData({ showDeposit: true })
      this.fieldError(deposit === null ? '订金须为非负金额，最多两位小数。' : '请填写订金收款方式。')
      return
    }
    let contact = (form.contact || '').trim()
    const lookup = !contact && !this.contactEdited && phone ? this.lookupCustomer() : null
    this.setData({ saving: true, formError: '' })
    try {
      if (lookup) {
        await lookup
        if (this.pageUnloaded || phoneInput(this.data.form.phone) !== phone) return
        contact = (this.data.form.contact || '').trim()
      }
      if (kind === 'booking' && !contact) {
        this.fieldError('请输入客人姓名。')
        return
      }
      const order = await call('save', {
        ...(orderId ? { id: orderId, version } : {}),
        date, meal, time, tableIds, guests, contact, phone, kind, deposit,
        notes: (form.notes || '').trim(),
        depositMethod,
        depositHandler: (form.depositHandler || '').trim(),
      })
      this.finish(order)
    } catch (error) {
      if (error.code === 'TABLE_CONFLICT') {
        const conflicts = new Set(error.tableIds || [])
        this.showSelection(tableIds.filter(id => !conflicts.has(id)))
        this.setData({ tableConflict: errorMessage(error, '有桌位已被占用，请重新选桌。') })
        this.revealTables()
        await this.loadBoard()
      } else if (error.code === 'VERSION_CONFLICT') {
        this.setData({ staleVersion: true })
      } else {
        this.fieldError(errorMessage(error, '保存失败，请重试。'))
      }
    } finally {
      if (!this.pageUnloaded) this.setData({ saving: false })
    }
  },

  finish(order) {
    const channel = this.getOpenerEventChannel()
    if (channel && channel.emit) channel.emit('saved', order.id)
    const message = this.data.editing ? '已保存' : (this.data.isWalkIn ? '散客已登记' : '预订已确认')
    const success = () => wx.showToast({ title: message, icon: 'success' })
    const pages = getCurrentPages()
    const previous = pages[pages.length - 2]
    if (this.data.editing && previous && previous.route === 'pages/order/index') {
      wx.navigateBack({ success })
    } else {
      wx.redirectTo({ url: orderUrl(order.id), success })
    }
  },

  goBack() {
    const pages = getCurrentPages()
    if (pages.length > 1) wx.navigateBack()
    else if (this.data.orderId) wx.redirectTo({ url: orderUrl(this.data.orderId) })
    else wx.switchTab({ url: '/pages/index/index' })
  },

  openAccount() {
    wx.switchTab({ url: '/pages/account/index' })
  },
})
