const { call } = require('../../lib/api')
const { canManageOrders, presentTables } = require('../../lib/reception')

const standardFloors = ['一楼', '二楼', '三楼']
const types = [{ id: 'hall', label: '散台' }, { id: 'room', label: '包间' }, { id: 'unknown', label: '待补充' }]

Page({
  data: { groups: [], floors: standardFloors, types, editing: false, existing: false, form: {}, loading: true, saving: false, error: '', formError: '', allowed: false },

  onShow() {
    this.visible = true
    return this.load()
  },
  onHide() {
    this.visible = false
    this.requestId = (this.requestId || 0) + 1
  },
  onUnload() {
    this.closed = true
    this.onHide()
  },

  async load() {
    const requestId = this.requestId = (this.requestId || 0) + 1
    this.setData({ loading: true, error: '', allowed: false })
    try {
      const { me, tables } = await call('bootstrap')
      if (!this.visible || requestId !== this.requestId) return
      if (!me.nameBound || !canManageOrders(me.role)) {
        this.tables = []
        this.setData({ error: '仅店长和管理员可以维护桌位。', editing: false, groups: [] })
        return
      }
      this.tables = tables
      const floors = Array.from(new Set([...standardFloors, ...tables.map(table => table.floor)]))
      const formatted = presentTables(tables)
      const groups = floors.map(floor => ({ floor, tables: formatted.filter(table => table.floor === floor) }))
      this.setData({ floors, groups, allowed: true })
    } catch (error) {
      if (requestId === this.requestId) this.setData({ error: error.message || '桌位加载失败，请重试。' })
    } finally {
      if (this.visible && requestId === this.requestId) this.setData({ loading: false })
    }
  },

  edit(event) {
    if (!this.data.allowed || this.data.saving) return
    const { id } = event.currentTarget.dataset
    const table = id ? this.tables.find(item => item.id === id) : null
    if (id && !table) return
    this.original = table
    const { name = '', floor = '一楼', type = 'hall', minCapacity, capacity } = table || {}
    this.setData({
      editing: true, existing: Boolean(table), formError: '',
      floorIndex: this.data.floors.indexOf(floor), typeIndex: types.findIndex(option => option.id === type),
      form: { name, floor, type, minCapacity: minCapacity ?? '', capacity: capacity ?? '' },
    })
    wx.pageScrollTo({ scrollTop: 0, duration: 0 })
  },

  field(event) {
    if (!this.data.saving) this.setData({ ['form.' + event.currentTarget.dataset.field]: event.detail.value, formError: '' })
  },
  selectFloor(event) {
    const floorIndex = Number(event.detail.value)
    this.setData({ floorIndex, 'form.floor': this.data.floors[floorIndex], formError: '' })
  },
  selectType(event) {
    const typeIndex = Number(event.detail.value)
    this.setData({ typeIndex, 'form.type': types[typeIndex].id, formError: '' })
  },
  cancel() {
    if (!this.data.saving) this.setData({ editing: false, formError: '' })
  },
  async save() {
    const { form, allowed, editing, saving } = this.data
    if (saving || !editing || !allowed) return
    if (!form.name.trim()) return this.setData({ formError: '请输入桌名。' })
    const before = this.original
    this.setData({ saving: true, formError: '' })
    try {
      await call('saveTable', { table: form, ...(before ? { id: before.id, expected: before } : {}) })
      if (this.closed) return
      this.setData({ editing: false })
      if (this.visible) {
        wx.showToast({ title: before ? '桌位已更新' : '桌位已添加' })
        await this.load()
      }
    } catch (error) {
      if (this.closed) return
      if (error.code === 'VERSION_CONFLICT' || error.code === 'FORBIDDEN') {
        this.setData({ editing: false })
        if (this.visible) {
          await this.load()
          wx.showModal({ title: '未能保存', content: error.message, showCancel: false })
        }
      } else {
        this.setData({ formError: error.message || '保存失败，请重试。' })
      }
    } finally {
      if (!this.closed) this.setData({ saving: false })
    }
  },
})
