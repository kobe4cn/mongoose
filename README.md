# @kobe4cn/nestjs-mongoose

基于官方 `@nestjs/mongoose` 12.0.0 的非官方修改版本，由 [Kevin Yang](https://github.com/kobe4cn) 维护，与 NestJS 官方团队无隶属关系。

- 上游项目：[nestjs/mongoose](https://github.com/nestjs/mongoose)
- 当前项目：[kobe4cn/mongoose](https://github.com/kobe4cn/mongoose)
- 问题反馈：[GitHub Issues](https://github.com/kobe4cn/mongoose/issues)

## 修改内容

- 为 `MongooseModule.forRootAsync()` 增加可选的 `tenantId` 配置。
- 按租户 ID 和连接名称缓存连接，未设置 `tenantId` 时不启用租户缓存。
- 缓存创建中的 Promise，让同一缓存键的并发初始化共享连接创建过程；创建失败时移除对应缓存，允许重试。
- 对缓存连接记录使用计数，最后一个使用者关闭时释放连接。

## 安装

发布到 npm 的 `next` 标签后，可使用以下命令安装：

```bash
npm install @kobe4cn/nestjs-mongoose@next mongoose
```

应用需提供兼容的依赖：NestJS 11 或 12、Mongoose 7/8/9、RxJS 7。

## 使用示例

从本包导入模块与装饰器：

```ts
import { MongooseModule, InjectModel, InjectConnection } from '@kobe4cn/nestjs-mongoose';
```

在 Nest 模块的 `imports` 中注册连接：

```ts
MongooseModule.forRootAsync({
  tenantId: 'tenant-a',
  connectionName: 'cats-db',
  useFactory: () => ({
    uri: 'mongodb://localhost/tenant_a',
  }),
});
```

模型注册与注入使用配置的 `connectionName`，而不是 `tenantId`：

```ts
MongooseModule.forFeature(
  [{ name: Cat.name, schema: CatSchema }],
  'cats-db',
);
```

```ts
@InjectModel(Cat.name, 'cats-db')
private readonly catModel: Model<Cat>;

@InjectConnection('cats-db')
private readonly connection: Connection;
```

其中 `Cat`、`CatSchema` 为应用定义的模型和 schema，`Model`、`Connection` 类型从 `mongoose` 导入。

同时注册多个租户连接时，请使用不同的 `connectionName`，以区分 Nest 注入 token。同一个租户 ID 与连接名称组合必须对应相同的数据库配置。此实现用于初始化时注册的连接，不会根据每次请求的租户 ID 自动切换模型。

基础用法可参考 [NestJS MongoDB 文档](https://docs.nestjs.com/techniques/mongodb)，使用时将包导入路径替换为 `@kobe4cn/nestjs-mongoose`。

## 本地构建与打包

```bash
npm install
npm run build
npm pack
```

## 许可证

本项目采用 [MIT 许可证](LICENSE)，保留上游项目的版权声明和许可证。原项目作者为 Kamil Myśliwiec，修改版由 Kevin Yang 维护。
