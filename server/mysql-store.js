const mysql = require('mysql2/promise')
const fs = require('node:fs/promises')
const path = require('node:path')
const { randomBytes } = require('node:crypto')
const { WECHAT_TEST_MODE, writes, fault, digest, passwordRecord, passwordMatches, validateInitialPassword, loginResult, initialState, refreshState, applyAction } = require('./store-rules')
const { describeSms, canSendSms } = require('./notifications')

const testDatabase = 'shh_booking_test'
const tables = [
  'shh_business (id TINYINT UNSIGNED PRIMARY KEY, snapshot LONGTEXT NULL)',
  'shh_credentials (id VARCHAR(40) PRIMARY KEY, salt CHAR(32) NOT NULL, hash CHAR(128) NOT NULL)',
  `shh_sessions (tokenHash CHAR(64) PRIMARY KEY, staffId VARCHAR(40) NOT NULL, expires BIGINT UNSIGNED NOT NULL,
                 INDEX (staffId), INDEX (expires))`,
  'shh_invites (token CHAR(32) PRIMARY KEY, orderId VARCHAR(191) NOT NULL UNIQUE)',
  'shh_notifications (dedup CHAR(64) PRIMARY KEY, status VARCHAR(16) NOT NULL, at BIGINT UNSIGNED NOT NULL)'
]
const identityTable = `shh_wechat_identities (identityHash CHAR(64) PRIMARY KEY, staffId VARCHAR(40) NOT NULL UNIQUE,
                                              failures TINYINT UNSIGNED NOT NULL DEFAULT 0,
                                              retryAt BIGINT UNSIGNED NOT NULL DEFAULT 0)`

function configError(message) {
  return fault('MYSQL_CONFIG', message)
}

function connectionOptions(env, wechatTest) {
  const address = /^(?:\[([^\]]+)\]|([^:\s]+)):(\d+)$/.exec(env.MYSQL_ADDRESS?.trim() || '')
  const port = Number(address?.[3])
  if (!address || port < 1 || port > 65535) throw configError('MYSQL_ADDRESS 须填写数据库的主机和端口')
  if (!env.MYSQL_USERNAME?.trim() || !env.MYSQL_PASSWORD) throw configError('请配置 MYSQL_USERNAME 和 MYSQL_PASSWORD')
  const database = env.MYSQL_DATABASE || (wechatTest ? testDatabase : 'shh_booking')
  const sharedSchemas = ['django_demo', 'mysql', 'information_schema', 'performance_schema', 'sys']
  if (!/^[a-zA-Z0-9_]{1,64}$/.test(database) || sharedSchemas.includes(database.toLowerCase())) {
    throw configError('MYSQL_DATABASE 须使用独立的门店数据库，例如 shh_booking')
  }
  if (wechatTest ? database !== testDatabase : database.toLowerCase() === testDatabase) {
    throw configError('微信测试门店只能使用 shh_booking_test，正式门店须使用独立数据库')
  }
  return { host: address[1] || address[2], port, user: env.MYSQL_USERNAME, password: env.MYSQL_PASSWORD,
    database, charset: 'utf8mb4_bin', connectTimeout: 5000 }
}

async function createDatabaseIfMissing(pool, options) {
  try {
    await pool.query('SELECT 1')
    return
  } catch (err) {
    if (err.code !== 'ER_BAD_DB_ERROR') throw err
  }

  const { database, ...server } = options
  const connection = await mysql.createConnection(server)
  try {
    await connection.query(`CREATE DATABASE IF NOT EXISTS ${mysql.escapeId(database)} CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`)
  } catch (err) {
    if (['ER_DBACCESS_DENIED_ERROR', 'ER_ACCESS_DENIED_ERROR', 'ER_SPECIFIC_ACCESS_DENIED_ERROR'].includes(err.code)) {
      throw configError('请先在 MySQL 中创建门店数据库并授予该账号建表和读写权限')
    }
    throw err
  } finally {
    await connection.end()
  }
}

function validateAdminRecord(salt, hash) {
  if (typeof salt !== 'string' || !/^[0-9a-f]{32}$/.test(salt) ||
      typeof hash !== 'string' || !/^[0-9a-f]{128}$/.test(hash)) {
    throw configError('初始店长凭据格式无效')
  }
  return { salt, hash }
}

async function initialAdmin(env, wechatTest) {
  if (env.STORE_ADMIN_RECORD !== undefined) {
    const fields = env.STORE_ADMIN_RECORD.trim().split(':')
    if (fields.length !== 2) throw configError('STORE_ADMIN_RECORD 格式无效')
    return validateAdminRecord(...fields)
  }
  const filename = env.STORE_ADMIN_RECORD_FILE || path.join(__dirname, 'private', 'initial-admin.json')
  let source
  try {
    source = await fs.readFile(filename, 'utf8')
  } catch (err) {
    if (err.code !== 'ENOENT' || env.STORE_ADMIN_RECORD_FILE) throw configError('无法读取初始店长凭据文件')
  }
  if (source !== undefined) {
    let record
    try {
      record = JSON.parse(source)
    } catch {
      throw configError('初始店长凭据文件格式无效')
    }
    return validateAdminRecord(record?.salt, record?.hash)
  }
  if (wechatTest) throw configError('新微信测试数据库需要 STORE_ADMIN_RECORD 或初始店长凭据文件')
  if (!env.STORE_ADMIN_PASSWORD) throw configError('新数据库需要配置初始店长凭据')
  validateInitialPassword(env.STORE_ADMIN_PASSWORD)
  return passwordRecord(env.STORE_ADMIN_PASSWORD)
}

async function first(db, sql, parameters) {
  const [rows] = await db.execute(sql, parameters)
  return rows[0]
}

async function readSnapshot(db, lock = false) {
  const sql = 'SELECT snapshot FROM shh_business WHERE id=1' + (lock ? ' FOR UPDATE' : '')
  const row = await first(db, sql)
  return row?.snapshot == null ? null : JSON.parse(row.snapshot)
}

function persist(connection, state) {
  return connection.execute('UPDATE shh_business SET snapshot=? WHERE id=1', [JSON.stringify(state)])
}

async function openMysqlStore(env = process.env) {
  const environment = env.STORE_MODE ?? 'production'
  const wechatTest = environment === WECHAT_TEST_MODE
  if (!wechatTest && environment !== 'production') throw configError('STORE_MODE 须为 production 或 wechat-test')
  const options = connectionOptions(env, wechatTest)
  const pool = mysql.createPool({ ...options, connectionLimit: 5, queueLimit: 30 })

  async function withState(write, operation) {
    const connection = await pool.getConnection()
    try {
      await connection.beginTransaction()
      // Serialize snapshot changes across all containers before reading business state.
      const state = await readSnapshot(connection, write)
      const result = await operation(connection, state)
      await connection.commit()
      return result
    } catch (err) {
      try {
        await connection.rollback()
      } catch {
        connection.destroy()
      }
      throw err
    } finally {
      connection.release()
    }
  }

  function assertEnvironment(state) {
    if (state && (state.environment === WECHAT_TEST_MODE) !== wechatTest) {
      throw configError('数据库已有其他模式的门店数据，请使用独立的数据库')
    }
  }

  try {
    await createDatabaseIfMissing(pool, options)
    if (wechatTest) {
      const existing = await readSnapshot(pool).catch(err => {
        if (err.code !== 'ER_NO_SUCH_TABLE') throw err
        return null
      })
      assertEnvironment(existing)
    }
    for (const table of wechatTest ? [...tables, identityTable] : tables) {
      await pool.query('CREATE TABLE IF NOT EXISTS ' + table + ' ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin')
    }
    await pool.execute('INSERT INTO shh_business (id,snapshot) VALUES (1,NULL) ON DUPLICATE KEY UPDATE id=1')
    await withState(true, async (connection, state) => {
      assertEnvironment(state)
      if (state) {
        if (refreshState(state)) await persist(connection, state)
        return
      }
      const { salt, hash } = await initialAdmin(env, wechatTest)
      await connection.execute('INSERT INTO shh_credentials (id,salt,hash) VALUES (?,?,?)', ['manager', salt, hash])
      const snapshot = initialState()
      if (wechatTest) {
        snapshot.environment = environment
        snapshot.staff = []
      }
      await persist(connection, snapshot)
    })
  } catch (err) {
    await pool.end().catch(() => {})
    if (err.code === 'MYSQL_CONFIG') throw err
    const code = typeof err.code === 'string' && /^[A-Z][A-Z0-9_]*$/.test(err.code) ? `（${err.code}）` : ''
    throw new Error(`门店 MySQL 初始化失败${code}`)
  }

  async function saveSession(connection, result) {
    const now = Date.now()
    await connection.execute('DELETE FROM shh_sessions WHERE expires<=?', [now])
    await connection.execute('INSERT INTO shh_sessions (tokenHash,staffId,expires) VALUES (?,?,?)',
      [digest(result.token), result.me.id, now + 12 * 3600 * 1000])
    return result
  }

  const dummy = wechatTest ? undefined : passwordRecord(randomBytes(24).toString('hex'))
  function login(id, password) {
    if (wechatTest) throw fault('NOT_FOUND', '接口不存在')
    return withState(true, async (connection, state) => {
      const record = await first(connection, 'SELECT salt,hash FROM shh_credentials WHERE id=?', [id])
      return saveSession(connection, loginResult(state, id, password, record, dummy))
    })
  }

  function saveWechatSession(connection, person) {
    return saveSession(connection, { token: randomBytes(32).toString('base64url'), me: { ...person } })
  }

  function loginWechat(identity) {
    return withState(true, async (connection, state) => {
      const binding = await first(connection, 'SELECT staffId FROM shh_wechat_identities WHERE identityHash=?', [identity])
      if (binding) {
        const person = state.staff.find(staff => staff.id === binding.staffId && staff.active !== false)
        if (!person) throw fault('UNAUTHORIZED', '员工账号已停用')
        return saveWechatSession(connection, person)
      }
      const person = { id: 'wx-' + randomBytes(16).toString('hex'), name: '', role: 'pending', nameBound: false, active: true }
      await connection.execute('INSERT INTO shh_wechat_identities (identityHash,staffId) VALUES (?,?)', [identity, person.id])
      state.staff.push(person)
      await persist(connection, state)
      return saveWechatSession(connection, person)
    })
  }

  async function sessionStaffId(token, db, identity) {
    const args = [digest(token), Date.now()]
    const session = identity
      ? await first(db, `SELECT s.staffId FROM shh_sessions s JOIN shh_wechat_identities w ON w.staffId=s.staffId
                          WHERE s.tokenHash=? AND s.expires>? AND w.identityHash=?`, [...args, identity])
      : await first(db, 'SELECT staffId FROM shh_sessions WHERE tokenHash=? AND expires>?', args)
    if (!session) throw fault('UNAUTHORIZED', wechatTest ? '请重新使用微信身份进入测试门店' : '请先登录门店员工账号')
    return session.staffId
  }

  function authenticate(token, identity) {
    if (wechatTest && !identity) throw fault('UNAUTHORIZED', '请重新使用微信身份进入测试门店')
    return sessionStaffId(token, pool, identity)
  }

  function revokeSessions(connection, staffId) {
    return connection.execute('DELETE FROM shh_sessions WHERE staffId=?', [staffId])
  }

  async function bindWechatAdmin(identity, token, password) {
    const result = await withState(true, async (connection, state) => {
      const staffId = await sessionStaffId(token, connection, identity)
      if (state.staff.some(staff => staff.id === 'manager')) throw fault('ADMIN_BOUND', '管理员已绑定微信')
      const person = state.staff.find(staff => staff.id === staffId && staff.active !== false && staff.role === 'pending')
      if (!person) throw fault('FORBIDDEN', '该微信员工无法绑定管理员')

      const now = Date.now()
      const { failures, retryAt } = await first(connection, 'SELECT failures,retryAt FROM shh_wechat_identities WHERE identityHash=?', [identity])
      const attempts = retryAt > now ? failures : 0
      if (attempts >= 5) throw fault('RATE_LIMIT', '尝试次数过多，请稍后绑定')
      const record = await first(connection, 'SELECT salt,hash FROM shh_credentials WHERE id=?', ['manager'])
      if (!record || !passwordMatches(password, record)) {
        await connection.execute('UPDATE shh_wechat_identities SET failures=?,retryAt=? WHERE identityHash=?',
          [attempts + 1, attempts ? retryAt : now + 10 * 60 * 1000, identity])
        return null
      }

      Object.assign(person, { id: 'manager', role: 'manager', name: person.nameBound ? person.name : '店长' })
      await connection.execute('UPDATE shh_wechat_identities SET staffId=?,failures=0,retryAt=0 WHERE identityHash=?', ['manager', identity])
      await connection.execute('DELETE FROM shh_credentials WHERE id=?', ['manager'])
      await revokeSessions(connection, staffId)
      await persist(connection, state)
      return saveWechatSession(connection, person)
    })
    if (!result) throw fault('AUTH_FAILED', '管理员绑定口令不正确')
    return result
  }

  async function runAction(connection, state, actorId, action, input, token) {
    if (token !== undefined && await sessionStaffId(token, connection) !== actorId) {
      throw fault('UNAUTHORIZED', '请先登录门店员工账号')
    }
    const { result, password, revokeStaffId } = applyAction(state, actorId, action, input)
    if (password) {
      const { salt, hash } = passwordRecord(password)
      await connection.execute('INSERT INTO shh_credentials (id,salt,hash) VALUES (?,?,?) ON DUPLICATE KEY UPDATE salt=?,hash=?',
        [result.id, salt, hash, salt, hash])
    }
    if (revokeStaffId) await revokeSessions(connection, revokeStaffId)
    if (writes.has(action)) await persist(connection, state)
    return result
  }

  function run(actorId, action, input = {}, token) {
    return withState(writes.has(action), (connection, state) => runAction(connection, state, actorId, action, input, token))
  }

  async function notificationStatus(key, db = pool) {
    const row = await first(db, 'SELECT status FROM shh_notifications WHERE dedup=?', [key])
    return row?.status || 'ready'
  }

  function prepareInvite(actorId, id, session, env) {
    return withState(true, async (connection, state) => {
      const context = await runAction(connection, state, actorId, 'notificationContext', { id }, session)
      const details = describeSms(context, env)
      const status = await notificationStatus(details.key, connection)
      const invite = await first(connection, 'SELECT token FROM shh_invites WHERE orderId=?', [id])
      const token = invite?.token || randomBytes(24).toString('base64url')
      if (!invite) await connection.execute('INSERT INTO shh_invites (token,orderId) VALUES (?,?)', [token, id])
      return { details, status, token }
    })
  }

  function claimSms(actorId, id, version, token, env) {
    return withState(true, async (connection, state) => {
      const context = await runAction(connection, state, actorId, 'notificationContext', { id, version }, token)
      const delivery = describeSms(context, env)
      const status = await notificationStatus(delivery.key, connection)
      if (canSendSms(delivery, status)) {
        const now = Date.now()
        await connection.execute(`INSERT INTO shh_notifications (dedup,status,at) VALUES (?,'pending',?)
                                  ON DUPLICATE KEY UPDATE status='pending',at=?`, [delivery.key, now, now])
      }
      return { ...delivery, status }
    })
  }

  return {
    storage: 'mysql', environment, run, login, authenticate, notificationStatus, prepareInvite, claimSms,
    ...(wechatTest ? { loginWechat, bindWechatAdmin } : {}),
    async checkHealth() {
      return Boolean(await first(pool, 'SELECT id FROM shh_business WHERE id=1 AND snapshot IS NOT NULL'))
    },
    read: () => readSnapshot(pool),
    async findInvite(token) {
      const invite = await first(pool, 'SELECT orderId FROM shh_invites WHERE token=?', [token])
      return invite?.orderId
    },
    setNotificationStatus: (key, status) => pool.execute('UPDATE shh_notifications SET status=? WHERE dedup=?', [status, key]),
    logout: token => pool.execute('DELETE FROM shh_sessions WHERE tokenHash=?', [digest(token)]),
    close: () => pool.end()
  }
}

module.exports = { openMysqlStore }
