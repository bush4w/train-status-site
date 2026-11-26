// 瓦片文件名匹配（纯函数，可测试）
// 约定：<layer>_s<size>_<lat>_<lon>.json，如 hsr_s6_35.5_103.json / stations_s3_...
// 历史 bug：调用方传 'hsr_'（带下划线）+ 函数再拼 '_s' → 匹配 'hsr__s*' 永远落空
// 回归测试见 tile-files.test.js

/**
 * 判断文件是否属于某层的瓦片
 * @param {string} filename 文件名
 * @param {string} layer 层名（不带下划线），如 'hsr' / 'conv' / 'stations'
 */
export function isLayerTile(filename, layer) {
  return filename.startsWith(`${layer}_s`) && filename.endsWith('.json')
}
