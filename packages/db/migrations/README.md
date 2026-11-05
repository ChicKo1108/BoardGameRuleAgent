# 数据库迁移

迁移实现位于 ../src/migrations，使用显式注册而非运行时 glob。执行入口为根目录 npm run db:migrate / db:status / db:revert。生产 synchronize 始终为 false。
