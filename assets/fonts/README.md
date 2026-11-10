# Noto Sans 简体中文字体

本项目使用 Google / Adobe 的 Noto Sans CJK SC，遵循 SIL Open Font License 1.1；原许可证和版权声明保存在本目录及 `server/fonts`。来源固定到 `server/fonts/source.json` 中的提交及 SHA-256。

- `noto-sans-sc.wxss`：包含界面文字和常见姓氏的 WOFF2 子集，内嵌在小程序内，离线可用。
- `coverage.json`：该子集包含的字符，用于判断接口数据是否需要完整字体。
- `server/fonts/noto-sans-sc-full.woff2`：完整字库，由同一学校后端按需提供；约 11 MB，仅遇到子集以外的汉字时加载，由客户端缓存。
- 衍生字体内部命名为 `Campus Noto SC` / `Campus Noto SC Full`，保留原版权及许可证。

首次遇到生僻字时，完整字体加载完成前可能短暂回退到系统字体。正式部署必须保证字体接口可访问并支持跨域，当前由 Node.js 服务返回 CORS 及缓存头。原始 OTF 不加入 Git；可通过固定来源下载，使用 `fonttools`、`brotli` 后运行 `python scripts/build-fonts.py` 重建。重新生成完整字库前需移除现有生成文件。

Excel 导出只指定 `Noto Sans CJK SC` 字体，不会嵌入字体；接收端电脑应安装该开源字体以获得一致显示。原始字体下载地址见 `server/fonts/source.json`。
