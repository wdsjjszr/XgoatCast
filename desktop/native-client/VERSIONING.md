客户端版本使用 SemVer 预发布格式，首个版本为 `0.0.1-beta.1`。只发布 Windows x64 安装包，命名为 `XgoatCast-版本-win-x64-setup.exe`。每次 UI 改版之前，在 versions/ 中保留当前源码；安装包保留在 out/ 中。

本仓库自用构建沿用独立版本序列；`UpdateManifestPath` 留空，不检查作者官网更新。「关于」提供本仓库 Actions 下载入口。不要通过虚增版本号来屏蔽作者更新，也不要将作者较高版本视为已合入其源码。

递增 version.h、app.rc、app.manifest 和安装器默认版本。先构建并测试 EXE，再执行 `node build-installer.cjs`。已生成的同名安装包和已发布版本的字节、日志不可覆盖。`out/XgoatCast-win-x64` 只是可替换的构建目录。完整流程见 [发布文档](../../docs/WINDOWS_CLIENT_RELEASE.md)。
