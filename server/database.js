const { DatabaseSync } = require('node:sqlite')
const { randomBytes } = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { ADMIN_ID, writes, fault, digest, passwordRecord, validateInitialPassword, loginResult, initialState, refreshState, applyAction } = require('./store-rules')
const { describeSms, canSendSms } = require('./notifications')

function openStore(directory, options = {}) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  const db = new DatabaseSync(path.join(directory, 'store.sqlite'))
  const previousEnvironment = db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='environment'").get()
  if (previousEnvironment && db.prepare('SELECT trial FROM environment WHERE id=1').get()?.trial === 1) {
    db.close()
    throw Error('STORE_DATA_DIR 须使用独立的正式门店数据库目录')
  }
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;')
  db.exec([
    'CREATE TABLE IF NOT EXISTS business (id INTEGER PRIMARY KEY CHECK(id=1), snapshot TEXT NOT NULL)',
    'CREATE TABLE IF NOT EXISTS credentials (id TEXT PRIMARY KEY, salt TEXT NOT NULL, hash TEXT NOT NULL)',
    'CREATE TABLE IF NOT EXISTS sessions (tokenHash TEXT PRIMARY KEY, staffId TEXT NOT NULL, expires INTEGER NOT NULL)',
    'CREATE TABLE IF NOT EXISTS invites (token TEXT PRIMARY KEY, orderId TEXT NOT NULL UNIQUE)',
    'CREATE TABLE IF NOT EXISTS notifications (dedup TEXT PRIMARY KEY, status TEXT NOT NULL, at INTEGER NOT NULL)'
  ].join(';'))
  const read = () => JSON.parse(db.prepare('SELECT snapshot FROM business WHERE id=1').get().snapshot)
  const persist = state => db.prepare('INSERT OR REPLACE INTO business VALUES (1,?)').run(JSON.stringify(state))
  function transaction(operation) {
    db.exec('BEGIN IMMEDIATE')
    try {
      const result = operation()
      db.exec('COMMIT')
      return result
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  }

  function setPassword(id, password) {
    const { salt, hash } = passwordRecord(password)
    db.prepare('INSERT OR REPLACE INTO credentials VALUES (?,?,?)').run(id, salt, hash)
  }

  function revokeSessions(id) {
    db.prepare('DELETE FROM sessions WHERE staffId=?').run(id)
  }

  transaction(() => {
    if (db.prepare('SELECT id FROM business').get()) {
      const state = read()
      if (refreshState(state)) persist(state)
      return
    }
    const state = initialState()
    const initial = []
    for (const person of state.staff) {
      const supplied = person.id === ADMIN_ID && options.adminPassword
      if (supplied) validateInitialPassword(supplied)
      const password = supplied || randomBytes(15).toString('base64url')
      setPassword(person.id, password)
      revokeSessions(person.id)
      if (!supplied) initial.push(person.name + '  ' + person.id + '  ' + password)
    }
    if (initial.length) {
      fs.writeFileSync(path.join(directory, 'first-login.txt'), initial.join('\n') + '\n', {mode: 0o600})
    }
    persist(state)
  })

  const dummy = passwordRecord(randomBytes(24).toString('hex'))
  function login(id, password) {
    return transaction(() => {
      const record = db.prepare('SELECT salt,hash FROM credentials WHERE id=?').get(id)
      const login = loginResult(read(), id, password, record, dummy)
      const now = Date.now()
      db.prepare('DELETE FROM sessions WHERE expires <= ?').run(now)
      db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(digest(login.token), id, now + 12 * 3600 * 1000)
      return login
    })
  }

  function authenticate(token) {
    const session = db.prepare('SELECT staffId FROM sessions WHERE tokenHash=? AND expires>?').get(digest(token), Date.now())
    if (!session) throw fault('UNAUTHORIZED', '请先登录门店员工账号')
    return session.staffId
  }

  function run(actorId, action, data = {}, token) {
    function invoke() {
      const state = read()
      // Recheck the session against this snapshot in case it was revoked while the request was read.
      if (token !== undefined && authenticate(token) !== actorId) throw fault('UNAUTHORIZED', '请先登录门店员工账号')
      const { result, password, revokeStaffId } = applyAction(state, actorId, action, data)
      if (password) setPassword(result.id, password)
      if (revokeStaffId) revokeSessions(revokeStaffId)
      if (writes.has(action)) persist(state)
      return result
    }
    return writes.has(action) ? transaction(invoke) : invoke()
  }

  function notificationStatus(key) {
    return db.prepare('SELECT status FROM notifications WHERE dedup=?').get(key)?.status || 'ready'
  }

  function prepareInvite(actorId, id, token, env) {
    return transaction(() => {
      const details = describeSms(run(actorId, 'notificationContext', { id }, token), env)
      const status = notificationStatus(details.key)
      db.prepare('INSERT OR IGNORE INTO invites (token,orderId) VALUES (?,?)').run(randomBytes(24).toString('base64url'), id)
      const invite = db.prepare('SELECT token FROM invites WHERE orderId=?').get(id)
      return { details, status, token: invite.token }
    })
  }

  function claimSms(actorId, id, version, token, env) {
    return transaction(() => {
      const delivery = describeSms(run(actorId, 'notificationContext', { id, version }, token), env)
      const status = notificationStatus(delivery.key)
      if (canSendSms(delivery, status)) {
        db.prepare("INSERT OR REPLACE INTO notifications (dedup,status,at) VALUES (?,'pending',?)").run(delivery.key, Date.now())
      }
      return { ...delivery, status }
    })
  }

  return { db, run, read, login, authenticate, transaction, prepareInvite, claimSms, notificationStatus,
    findInvite: token => db.prepare('SELECT orderId FROM invites WHERE token=?').get(token)?.orderId,
    setNotificationStatus: (key, status) => db.prepare('UPDATE notifications SET status=? WHERE dedup=?').run(status, key),
    logout: token => db.prepare('DELETE FROM sessions WHERE tokenHash=?').run(digest(token)), close: () => db.close() }
}

module.exports = { openStore, fault, digest }
