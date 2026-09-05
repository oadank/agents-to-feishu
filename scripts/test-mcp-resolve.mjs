import { resolveMcpArgPaths } from '../src/tools/mcp-path-resolve.js';
// 1) 本机存在的路径 → 原样
console.log('exists  :', resolveMcpArgPaths('win-desktop-helper', ['C:/D/opt/win-desktop-helper/mcp-bridge.js']));
// 2) 模拟别人机器的缺失路径 → 按注册表/标准安装位重定位
console.log('relocate:', resolveMcpArgPaths('win-desktop-helper', ['C:/some/other/place/mcp-bridge.js']));
// 3) 无锚点 MCP → 缺失路径原样返回
console.log('noanchor:', resolveMcpArgPaths('some-mcp', ['C:/no/such/file.js']));
