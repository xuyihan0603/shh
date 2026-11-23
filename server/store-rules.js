const { randomBytes, scryptSync, timingSafeEqual, createHash } = require('node:crypto')
const { seed, execute, requireStaffManager, isStaffId, ROLES, readServicePhone } = require('../miniprogram/lib/domain')
const { pilotLayout, applyPilotMessageDefaults } = require('../miniprogram/lib/pilot')

const WECHAT_TEST_MODE = 'wechat-test'
const writes = new Set(['save','cancel','arrive','settle','configure','import','staffSave','bindStaffName','setServicePhone','setStaffRole'])

function fault(code, message) {
  return Object.assign(new Error(message), { code })
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex')
}

function passwordRecord(password) {
  const salt = randomBytes(16).toString('hex')
  return { salt, hash: scryptSync(password, salt, 64).toString('hex') }
}

function validateInitialPassword(password) {
  if (password.length < 10 || password.length > 128) throw Error('初始店长密码长度须为 10 至 128 个字符')
}

function passwordMatches(password, { salt, hash }) {
  return timingSafeEqual(Buffer.from(hash, 'hex'), scryptSync(password, salt, 64))
}

function loginResult(state, id, password, record, dummy) {
  const matches = passwordMatches(password, record || dummy)
  const person = state.staff.find(s => s.id === id && s.active !== false)
  if (!matches || !person || !record) {
    throw fault('AUTH_FAILED', '员工账号或密码无效')
  }
  return { token: randomBytes(32).toString('base64url'), me: { ...person, nameBound: person.nameBound === true } }
}

function initialState() {
  const state = Object.assign(seed(), pilotLayout(), {
    orders: [],
    staff: [{ id: 'manager', name: '店长', role: 'manager', active: true, nameBound: false }]
  })
  applyPilotMessageDefaults(state)
  return state
}

function refreshState(state) {
  return applyPilotMessageDefaults(state)
}

function updateStaff(state, actor, input) {
  const {id,name,role,password,active = true} = input
  if (!isStaffId(id) ||
      typeof name !== 'string' || !name.trim() || name.trim().length > 40 ||
      !ROLES.includes(role) || typeof active !== 'boolean') throw fault('VALIDATION','员工资料有误')
  const old = state.staff.find(s => s.id === id)
  if (old && input.createOnly) throw fault('VALIDATION','该账号已存在，请更换员工账号')
  const previousRole = old && old.role
  if ((!old || password) && (typeof password !== 'string' || password.length < 10 || password.length > 128)) throw fault('VALIDATION','请设置 10 至 128 个字符的密码')
  if (id === actor.id && (!active || role !== 'manager')) throw fault('VALIDATION','当前店长须保留管理权限')
  const servicePhone = input.servicePhone === undefined ? old?.servicePhone : readServicePhone(input.servicePhone)
  const person = {id,name:name.trim(),role,active,nameBound: old?.nameBound === true,
    ...(servicePhone === undefined ? {} : {servicePhone})}
  if (old) Object.assign(old, person)
  else state.staff.push(person)
  const revoke = password || !active || (old && previousRole !== role)
  return { result: person, password, revokeStaffId: revoke ? id : undefined }
}

function applyAction(state, actorId, action, input) {
  const actor = state.staff.find(s => s.id === actorId && s.active !== false)
  if (!actor) throw fault('UNAUTHORIZED','员工账号已停用')
  const wechatTest = state.environment === WECHAT_TEST_MODE
  if (action === 'staffSave' || action === 'staffList') {
    if (wechatTest && actor.role === 'pending') throw fault('ACCESS_PENDING','请等待店长分配员工职位')
    requireStaffManager(actor)
    if (wechatTest && action === 'staffSave') throw fault('FORBIDDEN','请在员工职位中分配已登记的微信员工')
    if (action === 'staffSave') return updateStaff(state, actor, input)
    return { result: state.staff.map(person => ({ ...person, active: person.active !== false, nameBound: person.nameBound === true })) }
  }

  const result = execute(state, actorId, action, input)
  if (action === 'bootstrap' || action === 'notificationContext') result.trial = wechatTest
  return { result, revokeStaffId: action === 'setStaffRole' && result.role !== input.expectedRole ? result.id : undefined }
}

module.exports = { WECHAT_TEST_MODE, writes, fault, digest, passwordRecord, passwordMatches, validateInitialPassword, loginResult, initialState, refreshState, applyAction }
