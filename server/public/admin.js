'use strict'

const app = document.querySelector('#app')
const staffRoles = { sales: '营销', finance: '财务', manager: '店长' }
const roles = { ...staffRoles, admin: '管理员' }
const meals = { lunch: '午餐', dinner: '晚餐' }
const statuses = { booked: '已预订', arrived: '已到店', settled: '已结账', cancelled: '已取消' }
const tableTypes = { hall: '散台', room: '包间', unknown: '待确认' }
const depositMethods = new Map(Object.entries({ cash: '现金', wechat: '微信', alipay: '支付宝', bank: '银行卡', other: '其他' }))
const views = {
  report: { title: '财务报表', roles: ['admin', 'manager', 'finance'] },
  orders: { title: '订单核对', roles: Object.keys(roles) },
  handover: { title: '存量预订录入', roles: ['admin', 'manager'] },
  config: { title: '门店与桌位', roles: ['admin'] },
  staff: { title: '员工账号', roles: ['admin'] },
  profile: { title: '我的', roles: Object.keys(roles) }
}
const localDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' })
const localTime = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'short' })
const currency = new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const sessionKey = 'store-admin-session'
const state = { token: sessionStorage.getItem(sessionKey) || '' }
let viewRequest = 0
let boardRequest = 0
let orderRequest = 0

function escape(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])
}

function today() {
  const parts = Object.fromEntries(localDate.formatToParts().map(part => [part.type, part.value]))
  return `${parts.year}-${parts.month}-${parts.day}`
}

function yuan(value) {
  return `¥${currency.format(value)}`
}

async function fetchStore(path, body) {
  const headers = {}
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (state.token) headers.Authorization = `Bearer ${state.token}`
  let response
  try {
    response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', headers, body: JSON.stringify(body) })
  } catch {
    throw new Error('无法连接门店服务，请检查网络后重试。')
  }
  if (response.ok) return response
  const error = await response.json().catch(() => ({}))
  throw Object.assign(new Error(error.error || '门店服务暂时无法完成操作。'), { code: error.code, tableIds: error.tableIds })
}

async function api(action, data = {}) {
  return (await fetchStore(`/api/${action}`, data)).json()
}

function field(label, name, { value, attrs = '', type = 'text', embed = '', className = '' } = {}) {
  const control = embed || `<input name="${name}" type="${type}" value="${escape(value)}" ${attrs}>`
  return `<label class="field ${className}"><span class="label">${label}</span>${control}</label>`
}

function servicePhoneField(value, required = false) {
  return field('服务手机号', 'servicePhone', {
    type: 'tel', value, attrs: `maxlength="24" autocomplete="off" ${required ? 'required' : ''}`
  })
}

function options(values, selected) {
  return Object.entries(values).map(([value, label]) => (
    `<option value="${escape(value)}" ${value === selected ? 'selected' : ''}>${escape(label)}</option>`
  )).join('')
}

function select(name, values, selected, attrs = '') {
  return `<select name="${name}" ${attrs}>${options(values, selected)}</select>`
}

function message(value, error = false, scope = app) {
  const element = scope.querySelector('[data-feedback]')
  if (!element) return
  element.hidden = !value
  element.classList.toggle('error', error)
  element.textContent = value || ''
}

function feedback(attrs = '') {
  return `<div class="notice" data-feedback role="status" ${attrs} hidden></div>`
}

function brand(caption = '') {
  return `<div class="brand"><span class="brand-mark" aria-hidden="true"><i></i><i></i><i></i><i></i></span>
    <div><div class="brand-title">门店预订</div>${caption ? `<div class="brand-caption">${escape(caption)}</div>` : ''}</div></div>`
}

function showAccountForm(form) {
  app.innerHTML = `<main class="login">
    <aside class="login-brand">${brand()}<h1>门店管理后台</h1></aside>
    <section class="login-main">${form}</section>
  </main>`
}

function showLogin(error = '') {
  showAccountForm(`<form class="login-form" id="login">
    <h2>员工登录</h2>
    ${field('员工账号', 'staffId', { attrs: 'maxlength="40" autocomplete="username" required autofocus' })}
    ${field('密码', 'password', { type: 'password', attrs: 'maxlength="128" autocomplete="current-password" required' })}
    <button type="submit" class="btn btn-primary">登录</button>
    ${feedback()}
  </form>`)
  message(error, true)
}

function showNameBinding({ me, nameSuggestion }) {
  const bookingStaff = me.role !== 'finance'
  showAccountForm(`<form class="login-form" id="staff-name">
    <h2>${bookingStaff ? '绑定员工资料' : '绑定员工姓名'}</h2>
    <p>${bookingStaff ? '姓名用于记录接单人。服务手机号会显示在发给客人的预订通知中。' : '请填写并确认本人姓名。'}</p>
    ${field('员工姓名', 'name', { value: nameSuggestion, attrs: 'maxlength="40" autocomplete="name" required autofocus' })}
    ${bookingStaff ? servicePhoneField(me.servicePhone, true) : ''}
    <button type="submit" class="btn btn-primary">${bookingStaff ? '确认员工资料' : '确认姓名'}</button>
    <button type="button" class="btn" data-action="logout">退出登录</button>
    ${feedback()}
  </form>`)
}

function clearSession(error) {
  ++viewRequest
  ++boardRequest
  ++orderRequest
  state.token = ''
  state.context = null
  sessionStorage.removeItem(sessionKey)
  showLogin(error)
}

function startSession(context) {
  state.context = context
  if (!context.me.nameBound) return showNameBinding(context)
  const date = today()
  state.report = { date, month: date.slice(0, 7), period: 'day', staffId: '' }
  state.orders = { date: today(), meal: '', phone: '' }
  state.handover = { date: today(), meal: 'dinner' }
  state.people = null
  showView(Object.keys(views).find(id => views[id].roles.includes(context.me.role)))
}

function showView(view) {
  const { me, store } = state.context
  if (!views[view]?.roles.includes(me.role)) return
  state.view = view
  app.innerHTML = `<div class="shell">
    <aside class="sidebar">
      ${brand(store.name)}
      <nav class="nav" aria-label="后台功能">${Object.entries(views).filter(([, item]) => item.roles.includes(me.role)).map(([id, item]) => (
        `<button type="button" data-action="navigate" data-value="${id}" ${id === view ? 'aria-current="page"' : ''}>${item.title}</button>`
      )).join('')}</nav>
      <div class="account">
        <div><div class="account-name">${escape(me.name)}</div><div class="account-role">${roles[me.role]}</div></div>
        <button type="button" class="sign-out" data-action="logout">退出</button>
      </div>
    </aside>
    <main class="main"><div class="workspace">
      <header class="page-header"><div><h1>${views[view].title}</h1></div><div id="page-actions"></div></header>
      ${feedback('id="feedback"')}
      <div id="screen"></div>
    </div></main>
  </div><dialog id="detail-dialog" aria-labelledby="dialog-title"></dialog>`
  refreshView()
}

function showScreen(content, controls = '') {
  app.querySelector('#screen').innerHTML = content
  app.querySelector('#page-actions').innerHTML = controls
}

function empty(text) {
  return `<div class="card empty">${escape(text)}</div>`
}

function table(headers, rows, className = '') {
  return `<div class="card table-wrap"><table class="${className}"><thead><tr>${headers.map(header => (
    `<th scope="col" class="${header[1] || ''}">${header[0]}</th>`
  )).join('')}</tr></thead><tbody>${rows}</tbody></table></div>`
}

function badge(status) {
  return `<span class="badge ${escape(status)}">${escape(statuses[status] || status)}</span>`
}

function amount(order, { linkToOrder = false } = {}) {
  if (order.amount != null) return yuan(order.amount)
  if (order.status === 'cancelled') return '<span class="muted">未录</span>'
  if (linkToOrder) {
    return `<button type="button" class="link pending" data-action="order" data-value="${escape(order.id)}" aria-label="查看订单 ${escape(order.id)} 的待补金额">待补</button>`
  }
  return '<span class="pending">待补</span>'
}

function orderLink(order) {
  return `<button type="button" class="link order-reference" data-action="order" data-value="${escape(order.id)}">${escape(order.id)}</button>`
}

function staffName(order) {
  return order.kind === 'walkin' ? '散客' : order.ownerName
}

function reportQuery({ date, month, period }) {
  return { date: period === 'month' ? `${month}-01` : date, period }
}

function showReport() {
  const { date, month, period, data, staffId } = state.report
  const monthly = period === 'month'
  const filters = `<div class="card padding filters">
    ${field(monthly ? '用餐月份' : '用餐日', 'reportDate', monthly
      ? { value: month, type: 'month', attrs: 'placeholder="YYYY-MM" required' }
      : { value: date, type: 'date', attrs: 'required' })}
    <div class="segmented" role="group" aria-label="统计周期">
      <button type="button" data-action="report-period" data-value="day" aria-pressed="${!monthly}">日报</button>
      <button type="button" data-action="report-period" data-value="month" aria-pressed="${monthly}">月报</button>
    </div>
  </div>`
  const content = data ? reportContent(data, staffId) : state.loading ? empty('正在加载报表…') : retry('报表加载失败。')
  showScreen(`<div class="stack">${filters}${content}</div>`,
    `<button type="button" class="btn btn-primary" data-action="download" ${data ? '' : 'disabled'}>导出 Excel</button>`)
}

function reportContent(report, staffId) {
  const selected = report.rows.find(row => row.staffId === staffId)
  const detailRows = selected ? report.details.filter(order => (
    (order.kind === 'walkin' ? 'walkin' : order.ownerId) === staffId
  )) : report.details
  const { total } = report
  const metrics = [
    ['有效订单', total.orderCount, '单'], ['桌数', total.tableCount, '桌'], ['已录消费额', yuan(total.amount), '', 'primary'],
    ['金额待补', total.pending, '笔', total.pending ? 'pending' : ''], ['订金合计', yuan(total.deposit)]
  ]
  const summary = report.rows.map(row => `<tr ${row === selected ? 'class="selected"' : ''}>
    <td><button type="button" class="link" data-action="staff-report" data-value="${escape(row.staffId)}" aria-pressed="${row === selected}">${escape(row.name)}</button></td>
    <td class="qty">${row.orderCount}</td><td class="qty">${row.tableCount}</td><td class="money">${yuan(row.amount)}</td>
    <td class="qty ${row.pending ? 'pending' : ''}">${row.pending}</td><td class="money">${yuan(row.deposit)}</td></tr>`).join('')
  const detail = detailRows.map(order => `<tr>
    <td>${orderLink(order)}</td><td>${escape(staffName(order))}</td>
    <td class="mono">${escape(order.date)}</td>
    <td class="mono">${meals[order.meal]} ${escape(order.time)}</td><td>${escape(order.tableNames.join('、'))}</td>
    <td class="qty">${order.tableIds.length}</td><td>${badge(order.status)}</td>
    <td class="money">${amount(order, { linkToOrder: true })}</td><td class="money">${yuan(order.deposit)}</td></tr>`).join('')
  const amountCols = [['消费额', 'money'], ['订金', 'money']]
  return `<div class="metrics" aria-label="${report.period === 'month' ? '当月合计' : '当日合计'}">${metrics.map(([label, value, unit, tone = '']) => (
    `<div class="card metric ${tone}"><span>${label}</span><strong>${value}${unit ? ` <small class="unit">${unit}</small>` : ''}</strong></div>`
  )).join('')}</div>
  <section><div class="section-heading"><h2>员工汇总</h2></div>
    ${summary ? table([['接单员工'], ['有效单数', 'qty'], ['桌数', 'qty'], ['已录消费额', 'money'], ['待补笔数', 'qty'], ['订金', 'money']], summary) : empty('当前统计周期暂无有效订单。')}
  </section>
  <section id="report-details" tabindex="-1">
    <div class="section-heading"><h2>${selected ? `${escape(selected.name)}的订单` : '订单明细'}</h2>
      ${selected ? '<button type="button" class="link" data-action="staff-report" data-value="">查看全部</button>' : ''}
    </div>
    ${detail ? table([['订单编号'], ['接单员工'], ['用餐日'], ['餐段'], ['桌位'], ['桌数', 'qty'], ['状态'], ...amountCols], detail) : empty('当前筛选下暂无订单。')}
  </section>`
}

function showOrders() {
  const { date, meal, phone, data } = state.orders
  const filters = `<form id="order-search" class="card padding filters">
    ${field('用餐日', 'date', { type: 'date', value: date })}
    ${field('餐段', 'meal', { embed: select('meal', { '': '全部餐段', ...meals }, meal) })}
    ${field('联系手机号', 'phone', { type: 'tel', value: phone, className: 'phone-filter', attrs: 'maxlength="25"' })}
    <button type="submit" class="btn btn-primary">查询</button>
  </form>`
  const rows = (data || []).map(order => `<tr><td>${orderLink(order)}</td>
    <td class="mono">${escape(order.date)}<br><span class="muted">${meals[order.meal]} ${escape(order.time)}</span></td>
    <td>${escape(order.tableNames.join('、'))}</td><td>${escape(order.contact || '散客')}</td>
    <td>${escape(staffName(order))}</td><td>${badge(order.status)}</td><td class="money">${amount(order)}</td><td class="money">${yuan(order.deposit)}</td></tr>`).join('')
  const content = rows ? table([['订单编号'], ['用餐日'], ['桌位'], ['联系人'], ['接单员工'], ['状态'], ['消费额', 'money'], ['订金', 'money']], rows) : (
    empty(state.loading ? '正在查询订单…' : data ? '当前条件下暂无订单。' : '订单查询失败。')
  )
  showScreen(`<div class="stack">${filters}${content}</div>`)
}

function configRow(tableData, index, existingIds) {
  const existing = existingIds.has(tableData.id)
  return `<tr data-table-row><td>${field('桌位编号', 'tableId', { className: 'cell-field', value: tableData.id, attrs: `required ${existing ? 'readonly' : ''}` })}</td>
    <td>${field('桌名', 'tableName', { className: 'cell-field', value: tableData.name, attrs: 'required' })}</td>
    <td>${field('楼层', 'tableFloor', { className: 'cell-field', value: tableData.floor, attrs: 'required' })}</td>
    <td>${field('类型', 'tableType', { className: 'cell-field', embed: select('tableType', tableTypes, tableData.type) })}</td>
    <td>${field('最少人数', 'tableMinCapacity', { className: 'cell-field', type: 'number', value: tableData.minCapacity, attrs: 'min="1" step="1"' })}</td>
    <td>${field('最多人数', 'tableCapacity', { className: 'cell-field', type: 'number', value: tableData.capacity, attrs: 'min="1" step="1"' })}</td>
    <td><button type="button" class="link danger" data-action="table-remove" data-value="${index}" aria-label="移除${escape(tableData.name || '桌位')}">移除</button></td></tr>`
}

function showConfig(draft = state.context) {
  const { store, tables } = draft
  const existingIds = new Set(state.context.tables.map(item => item.id))
  showScreen(`<form id="config" class="stack">
    <section class="card padding"><div class="section-heading"><h2>门店资料</h2></div><div class="form-grid">
      ${field('门店名称', 'name', { value: store.name, attrs: 'required' })}
      ${field('门店电话', 'phone', { value: store.phone, type: 'tel' })}
      ${field('门店地址', 'address', { value: store.address })}
    </div></section>
    <section><div class="section-heading"><h2>桌位</h2><button type="button" class="btn" data-action="table-add">新增桌位</button></div>
      ${tables.length ? table([['桌位编号', 'id'], ['桌名', 'name'], ['楼层', 'floor'], ['类型', 'type'], ['最少人数', 'capacity'], ['最多人数', 'capacity'], ['操作']],
        tables.map((item, index) => configRow(item, index, existingIds)).join(''), 'config-tables') : empty('暂无桌位。')}
    </section>
    <div class="form-footer"><button type="submit" class="btn btn-primary">保存配置</button></div>
  </form>`)
}

function configDraft(form) {
  const values = dataOf(form)
  return {
    store: { name: values.name, phone: values.phone, address: values.address },
    tables: Array.from(form.querySelectorAll('[data-table-row]'), row => {
      const get = name => row.querySelector(`[name="${name}"]`).value
      return { id: get('tableId'), name: get('tableName'), floor: get('tableFloor'), type: get('tableType'),
        minCapacity: get('tableMinCapacity') || null, capacity: get('tableCapacity') || null }
    })
  }
}

function showHandover() {
  const { date, meal, createdDate } = state.handover
  const staff = state.context.staff.filter(person => person.role !== 'finance')
  const owners = Object.fromEntries(staff.map(person => [person.id, person.name]))
  showScreen(`<form id="handover" class="stack">
    <section class="card padding"><div class="section-heading"><h2>用餐安排</h2></div><div class="form-grid">
      ${field('用餐日', 'date', { type: 'date', value: date, attrs: `min="${today()}" required` })}
      ${field('餐段', 'meal', { embed: select('meal', meals, meal) })}
      ${field('到店时间', 'time', { type: 'time', attrs: 'required' })}
      ${field('人数', 'guests', { type: 'number', attrs: 'required min="1" step="1"' })}
    </div></section>
    <section class="card padding"><div class="section-heading"><h2>选择桌位</h2><button type="button" class="link" data-action="board-reload">刷新桌态</button></div><div class="board" id="board" aria-live="polite"></div></section>
    <section class="card padding"><div class="section-heading"><h2>接单与订金</h2></div><div class="form-grid">
      ${field('联系人', 'contact', { attrs: 'required autocomplete="off"' })}
      ${field('联系电话', 'phone', { type: 'tel', attrs: 'required autocomplete="off"' })}
      ${field('原接单员工', 'ownerId', { embed: select('ownerId', { '': '请选择', ...owners }, state.handover.ownerId || '', 'required') })}
      ${field('原接单日', 'createdDate', { type: 'date', value: createdDate || today(), attrs: `max="${today()}" required` })}
      ${field('实收订金（元）', 'deposit', { value: '0', type: 'number', attrs: 'min="0" step=".01"' })}
      ${field('订金收款方式', 'depositMethod', { attrs: 'placeholder="如微信、现金"' })}
      ${field('订金经手人', 'depositHandler')}
      ${field('备注', 'notes', { className: 'full', embed: '<textarea name="notes" rows="2"></textarea>' })}
    </div></section>
    <div class="form-footer"><button type="submit" name="saveBooking" class="btn btn-primary" disabled>保存预订</button></div>
  </form>`)
  refreshBoard(app.querySelector('#handover'))
}

function capacityText({ minCapacity, capacity }) {
  if (capacity == null) return '人数待补充'
  return minCapacity && minCapacity !== capacity ? `${minCapacity}–${capacity} 人` : `${capacity} 人`
}

function drawBoard(tables, selected) {
  const floors = new Map()
  for (const item of tables) {
    if (!floors.has(item.floor)) floors.set(item.floor, [])
    floors.get(item.floor).push(item)
  }
  return Array.from(floors, ([floor, floorTables]) => `<section class="floor-group"><h3>${escape(floor)}</h3><div class="tables">
    ${floorTables.map(item => `<label class="table-option ${item.orderId ? 'occupied' : ''}">
      <input type="checkbox" name="tableIds" value="${escape(item.id)}" ${item.orderId ? 'disabled' : selected.has(item.id) ? 'checked' : ''}>
      <span><strong>${escape(item.name)}</strong><small>${item.orderId ? '已占 · ' : ''}${tableTypes[item.type]} · ${escape(capacityText(item))}</small></span>
    </label>`).join('')}
  </div></section>`).join('') || '<p class="muted">暂无桌位，请先维护门店配置。</p>'
}

async function refreshBoard(form, keepSelection = false) {
  const { date, meal } = dataOf(form)
  const selected = new Set(keepSelection ? new FormData(form).getAll('tableIds') : [])
  const board = form.querySelector('#board')
  const submit = form.elements.saveBooking
  const request = ++boardRequest
  state.handover.date = date
  state.handover.meal = meal
  form.dataset.boardReady = ''
  submit.disabled = true
  if (!date) {
    board.textContent = '请选择用餐日。'
    return
  }
  board.textContent = '正在加载桌位…'
  try {
    const result = await api('board', { date, meal })
    if (!board.isConnected || request !== boardRequest) return
    board.innerHTML = drawBoard(result.tables, selected)
    form.dataset.boardReady = result.tables.some(item => !item.orderId) ? 'yes' : ''
    submit.disabled = !form.dataset.boardReady
  } catch (error) {
    if (!board.isConnected || request !== boardRequest) return
    if (error.code === 'UNAUTHORIZED') clearSession(error.message)
    else board.textContent = error.message
  }
}

function showStaff() {
  const rows = (state.people || []).map(person => `<tr>
    <td>${escape(person.name)}</td><td class="mono">${escape(person.id)}</td><td>${roles[person.role]}</td>
    <td class="mono">${escape(person.servicePhone || '—')}</td>
    <td><span class="badge ${person.active ? '' : 'inactive'}">${person.active ? '启用' : '停用'}</span></td>
    <td><button type="button" class="link" data-action="staff-edit" data-value="${escape(person.id)}">编辑</button></td></tr>`).join('')
  showScreen(rows ? table([['姓名'], ['员工账号'], ['岗位'], ['服务手机号'], ['状态'], ['操作']], rows) : state.loading ? empty('正在加载员工账号…') : retry('员工账号加载失败。'),
    `<button type="button" class="btn btn-primary" data-action="staff-add" ${state.people ? '' : 'disabled'}>新增员工</button>`)
}

function showProfile() {
  showScreen(`<form id="staff-service-phone" class="card padding stack">
    <p class="help">此号码用于预订通知，客人可通过它联系接单人。</p>
    <div class="filters">
      ${servicePhoneField(state.context.me.servicePhone)}
      <button type="submit" class="btn btn-primary">保存手机号</button>
    </div>
  </form>`)
}

function showDialog(title, body) {
  const dialog = app.querySelector('#detail-dialog')
  dialog.innerHTML = `<div class="dialog-header"><h2 id="dialog-title">${title}</h2>
    <button type="button" class="close" aria-label="关闭" data-action="close">×</button></div>
    <div class="dialog-body">${body}</div>`
  if (!dialog.open) dialog.showModal()
  return dialog
}

function staffDialog(person) {
  const editing = Boolean(person)
  showDialog(editing ? '编辑员工' : '新增员工', `<form id="staff-form" class="stack" data-editing="${editing}">
    ${feedback()}
    <div class="form-grid">
      ${field('姓名', 'name', { value: person?.name, attrs: 'required maxlength="40"' })}
      ${field('员工账号', 'id', { value: person?.id, attrs: editing ? 'readonly' : 'required pattern="[A-Za-z0-9_\\-]+" maxlength="40" autocomplete="off"' })}
      ${field('岗位', 'role', { embed: select('role', person?.role === 'admin' ? { admin: roles.admin } : staffRoles, person?.role || 'sales') })}
      ${field('状态', 'active', { embed: select('active', { true: '启用', false: '停用' }, editing ? String(person.active) : 'true') })}
      ${servicePhoneField(person?.servicePhone)}
      ${field(editing ? '新密码（选填）' : '初始密码', 'password', { type: 'password', className: 'full',
        attrs: `minlength="10" maxlength="128" autocomplete="new-password" ${editing ? '' : 'required'}` })}
      <p class="help full">密码长度为 10 至 128 个字符。</p>
    </div>
    <div class="form-footer"><button type="submit" class="btn btn-primary">保存员工</button></div>
  </form>`)
}

function orderDetails(order) {
  const fields = [
    ['状态', badge(order.status)], ['接单员工', escape(staffName(order))],
    ['用餐日', `${escape(order.date)} ${meals[order.meal]} ${escape(order.time)}`], ['接单日', escape(order.createdDate)],
    ['桌位', `${escape(order.tableNames.join('、'))} · ${order.tableIds.length} 桌`], ['人数', `${order.guests} 人`],
    ['联系人', escape(order.contact || '—')], ['联系电话', escape(order.phone || '—')],
    ['最终消费额', amount(order)], ['实收订金', yuan(order.deposit)],
    ['订金收款方式', escape(depositMethods.get(order.depositMethod) || order.depositMethod || '—')], ['订金经手人', escape(order.depositHandler || '—')]
  ]
  const editor = order.canSettle ? `<form id="settle" class="filters" data-id="${escape(order.id)}" data-version="${order.version}">
    ${field('小票最终消费额（元）', 'amount', { value: order.amount, type: 'number', attrs: 'required min="0" step=".01"' })}
    <button type="submit" class="btn btn-primary">保存消费额</button>
    <p class="help">填写含已抵扣订金的最终消费额。</p>
  </form>` : ''
  const logs = order.logs.length ? `<section><h3>操作记录</h3><ul class="logs">${order.logs.map(log => (
    `<li>${escape(localTime.format(new Date(log.at)))}　${escape(log.actorName)}　${escape(log.action)}</li>`
  )).join('')}</ul></section>` : ''
  return `<div class="stack">${feedback()}
    <dl class="dialog-details">${fields.map(([label, value]) => `<div><dt>${label}</dt><dd>${value}</dd></div>`).join('')}
    ${order.notes ? `<div class="full"><dt>备注</dt><dd>${escape(order.notes)}</dd></div>` : ''}</dl>${editor}${logs}</div>`
}

async function openOrder(id) {
  const request = ++orderRequest
  const dialog = showDialog('订单详情', '<p class="muted">正在读取订单…</p>')
  dialog.dataset.order = id
  const active = () => request === orderRequest && dialog.isConnected && dialog.open
  try {
    const order = await api('order', { id })
    if (active()) showDialog(`订单 ${escape(order.id)}`, orderDetails(order))
  } catch (error) {
    if (!active()) return
    if (error.code === 'UNAUTHORIZED') clearSession(error.message)
    else showDialog('订单详情', `<p class="notice error" role="status">${escape(error.message)}</p>`)
  }
}

async function refreshView() {
  const request = ++viewRequest
  const view = state.view
  state.loading = true
  message('')
  const finish = async (action, data, render, apply) => {
    render()
    try {
      const result = await api(action, data)
      if (request !== viewRequest) return
      state.loading = false
      apply(result)
      render()
    } catch (error) {
      if (request !== viewRequest) return
      state.loading = false
      if (error.code === 'UNAUTHORIZED') clearSession(error.message)
      else {
        render()
        message(error.message, true)
      }
    }
  }
  if (view === 'report') {
    const report = state.report
    report.data = null
    return finish('report', reportQuery(report), showReport, data => {
      report.data = data
      if (!data.rows.some(row => row.staffId === report.staffId)) report.staffId = ''
    })
  }
  if (view === 'orders') {
    const orders = state.orders
    orders.data = null
    const filters = Object.fromEntries(['date', 'meal', 'phone'].filter(name => orders[name]).map(name => [name, orders[name]]))
    return finish('orders', filters, showOrders, data => { orders.data = data })
  }
  if (view === 'staff') {
    state.people = null
    return finish('staffList', {}, showStaff, people => { state.people = people })
  }
  if (view === 'handover') showHandover()
  if (view === 'config') showConfig()
  if (view === 'profile') showProfile()
  state.loading = false
}

function dataOf(form) {
  return Object.fromEntries(new FormData(form))
}

function retry(text) {
  return `<div class="card empty retry">${escape(text)}<button type="button" class="link" data-action="retry">重新加载</button></div>`
}

async function submitLogin(form) {
  if (form.dataset.sending) return
  const button = form.querySelector('button[type=submit]')
  form.dataset.sending = 'yes'
  button.disabled = true
  message('')
  try {
    const data = dataOf(form)
    const result = await (await fetchStore('/auth/login', { staffId: data.staffId.trim(), password: data.password })).json()
    state.token = result.token
    const context = await api('bootstrap')
    sessionStorage.setItem(sessionKey, state.token)
    startSession(context)
  } catch (error) {
    clearSession(error.message)
  }
}

async function bindStaffName(form) {
  const token = state.token
  const { name, servicePhone } = dataOf(form)
  await api('bindStaffName', { name, servicePhone })
  if (state.token !== token) return
  const context = await api('bootstrap')
  if (state.token === token) startSession(context)
}

async function withForm(form, work) {
  if (form.dataset.sending) return
  const button = form.querySelector('button[type=submit]')
  const dialog = form.closest('dialog')
  const id = form.getAttribute('id')
  form.dataset.sending = 'yes'
  button.disabled = true
  message('', false, dialog || app)
  try {
    await work()
  } catch (error) {
    if (!form.isConnected) return
    if (error.code === 'UNAUTHORIZED') clearSession(error.message)
    else if (error.code === 'VERSION_CONFLICT' && id === 'settle') {
      await openOrder(form.dataset.id)
      if (dialog?.open) message('订单已更新，请核对最新资料后再提交。', true, dialog)
    } else if (error.code === 'TABLE_CONFLICT' && id === 'handover') {
      await refreshBoard(form, true)
      if (form.isConnected) message(error.message, true)
    } else message(error.message, true, dialog || app)
  } finally {
    form.dataset.sending = ''
    button.disabled = id === 'handover' && !form.dataset.boardReady
  }
}

async function settle(form) {
  const { id, version } = form.dataset
  const token = state.token
  const dialog = form.closest('dialog')
  const updated = await api('settle', { id, version: Number(version), amount: dataOf(form).amount })
  if (token !== state.token) return
  if (state.view === 'report' || state.view === 'orders') await refreshView()
  if (dialog.isConnected && dialog.open && dialog.dataset.order === id) {
    ++orderRequest
    showDialog(`订单 ${escape(updated.id)}`, orderDetails(updated))
    message('最终消费额已保存。', false, dialog)
  }
}

async function saveConfig(form) {
  const token = state.token
  const updated = await api('configure', { ...configDraft(form), expectedTables: state.context.tables })
  if (state.token !== token) return
  Object.assign(state.context, updated)
  if (!form.isConnected) return
  showView('config')
  message('门店配置已保存。')
}

async function saveStaff(form) {
  const { id, name, role, active, password, servicePhone } = dataOf(form)
  const creating = form.dataset.editing === 'false'
  if (creating && state.people.some(person => person.id === id)) throw new Error('员工账号已存在。')
  const phoneChanged = servicePhone !== form.elements.servicePhone.defaultValue
  const saved = await api('staffSave', { id, name, role, active: active === 'true', createOnly: creating,
    ...(password ? { password } : {}), ...(phoneChanged ? { servicePhone } : {}) })
  if (!form.isConnected) return
  if (saved.id === state.context.me.id && password) {
    clearSession('密码已更新，请重新登录。')
    return
  }
  const dialog = form.closest('dialog')
  dialog.close()
  const index = state.people.findIndex(person => person.id === saved.id)
  if (index < 0) state.people.push(saved)
  else state.people[index] = saved
  if (state.context.me.id === saved.id) state.context.me = saved
  state.context.staff = state.people.map(({ id, name, role, nameBound }) => ({ id, name, role, nameBound }))
  app.querySelector('.account-name').textContent = state.context.me.name
  showStaff()
  message('员工账号已保存。')
}

async function saveServicePhone(form) {
  const token = state.token
  const { servicePhone } = dataOf(form)
  const me = await api('setServicePhone', { servicePhone })
  if (state.token !== token) return
  state.context.me = me
  if (!form.isConnected) return
  form.elements.servicePhone.value = me.servicePhone || ''
  message('服务手机号已保存。')
}

async function saveHandover(form) {
  if (!form.dataset.boardReady) return
  const tableIds = new FormData(form).getAll('tableIds')
  if (!tableIds.length) throw new Error('请选择至少一张空桌。')
  const data = dataOf(form)
  delete data.saveBooking
  const [saved] = await api('import', { orders: [{ ...data, tableIds, kind: 'booking' }] })
  if (!form.isConnected) return
  state.handover.createdDate = data.createdDate
  state.handover.ownerId = data.ownerId
  showHandover()
  message(`预订 ${saved.id} 已录入，可继续录入下一笔。`)
}

async function download(button) {
  button.disabled = true
  const query = reportQuery(state.report)
  const monthly = query.period === 'month'
  message('')
  try {
    const response = await fetchStore(`/api/export?${new URLSearchParams(query)}`)
    const href = URL.createObjectURL(await response.blob())
    const anchor = document.createElement('a')
    anchor.download = `门店${monthly ? '月报' : '日报'}-${monthly ? query.date.slice(0, 7) : query.date}.xlsx`
    anchor.href = href
    document.body.append(anchor)
    anchor.click()
    anchor.remove()
    setTimeout(() => URL.revokeObjectURL(href), 30_000)
  } catch (error) {
    if (!button.isConnected) return
    if (error.code === 'UNAUTHORIZED') clearSession(error.message)
    else message(error.message, true)
  } finally {
    button.disabled = false
  }
}

const submits = { settle, config: saveConfig, 'staff-form': saveStaff, 'staff-name': bindStaffName, 'staff-service-phone': saveServicePhone, handover: saveHandover }

app.addEventListener('submit', event => {
  event.preventDefault()
  const form = event.target
  const id = form.getAttribute('id')
  if (id === 'login') submitLogin(form)
  else if (id === 'order-search') {
    const data = dataOf(form)
    state.orders = { ...data, phone: data.phone.trim() }
    refreshView()
  } else if (submits[id]) withForm(form, () => submits[id](form))
})

app.addEventListener('change', event => {
  const { name, value } = event.target
  if (name === 'reportDate') {
    const report = state.report
    const monthly = report.period === 'month'
    if (!value || (monthly && !/^\d{4}-(0[1-9]|1[0-2])$/.test(value))) {
      event.target.value = monthly ? report.month : report.date
      return
    }
    report.month = value.slice(0, 7)
    if (!monthly) report.date = value
    report.staffId = ''
    refreshView()
  }
  if (event.target.form?.id === 'handover' && (name === 'date' || name === 'meal')) refreshBoard(event.target.form)
})

const actions = {
  navigate: value => { if (value !== state.view) showView(value) },
  async logout() {
    const request = fetchStore('/auth/logout', {}).catch(() => {})
    clearSession()
    await request
  },
  'report-period'(value) {
    if (value === state.report.period) return
    Object.assign(state.report, { period: value, staffId: '' })
    refreshView()
  },
  'staff-report'(value) {
    state.report.staffId = value
    showReport()
    const detail = app.querySelector('#report-details')
    detail.focus({ preventScroll: true })
    if (value) detail.scrollIntoView({ block: 'nearest' })
  },
  order: openOrder,
  retry: () => refreshView(),
  download: (_value, button) => download(button),
  'staff-edit': id => staffDialog(state.people.find(person => person.id === id)),
  'staff-add': () => staffDialog(),
  'table-add'() {
    const draft = configDraft(app.querySelector('#config'))
    draft.tables.push({ id: '', name: '', floor: draft.tables.at(-1)?.floor || '', type: 'unknown', capacity: null })
    showConfig(draft)
    app.querySelector('[data-table-row]:last-child input').focus()
  },
  'table-remove'(index) {
    const draft = configDraft(app.querySelector('#config'))
    draft.tables.splice(Number(index), 1)
    showConfig(draft)
  },
  'board-reload': () => refreshBoard(app.querySelector('#handover'), true),
  close: () => app.querySelector('#detail-dialog').close()
}

app.addEventListener('click', event => {
  const button = event.target.closest('button[data-action]')
  if (button) actions[button.dataset.action]?.(button.dataset.value, button)
})

if (state.token) api('bootstrap').then(startSession, error => clearSession(error.message))
else showLogin()
