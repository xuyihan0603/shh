# 测试门店架构

小程序通过 `wx.cloud.callContainer` 请求微信云托管服务。关闭公网访问后，服务端从微信注入的请求头确认来源、小程序和员工微信身份。员工使用自己的微信登录，唯一管理员分配营销、财务或店长职位。手机号和姓名是业务资料，身份按微信账号识别。

云服务在 `shh_booking_test` 中持久化订单、员工、会话和邀请。新员工待授权时只可登记自己的资料。唯一的管理员使用绑定口令将自己的微信与预置的管理账号绑定。审批、改职与订单写入在数据库事务内完成。

- `miniprogram/lib/api.js` 使用云托管调用员工和预订接口。
- `miniprogram/lib/domain.js` 校验桌态、业务权限、订单版本，计算按用餐日统计的报表。
- `server/mysql-store.js` 使用 InnoDB 事务，写入前锁定门店快照，多实例共用相同的数据和员工权限。
- `server/notifications.js` 和 `miniprogram/lib/invitation.js` 负责预订正文、邀请及短信。
- `miniprogram/lib/workbook.js` 输出日报和月报的汇总及明细。

在微信云托管配置 Git 仓库与部署参数的步骤见根目录 README。
