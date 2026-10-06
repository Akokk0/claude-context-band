// 带里每一张图(仪表、进度行、子代理行)共用的外框:内容多宽、两边留多少边、用什么字。
//
// 内容画在横向 0 到 WIDTH 之间,图本身比内容两边各宽出 GUTTER。留这道边是因为龙卷风的头像贴着内容的左沿,
// 它往外扩的那圈波纹要伸出去这么多,而图的边界会把出界的部分切掉(真带子上左边被切掉过一截)。
// 宿主把每张图居中、原大摆在那一条里,那一条比图窄了就等比缩小:两边留得一样宽,内容就还在原处;
// 三种图留得一样宽,缩小的时候才缩得一样多,行和仪表上下对得齐。所以三种图都从这里起头。

/** 内容的宽度,CSS 像素。 */
export const WIDTH = 680;
/** 内容两边各留的边,CSS 像素。 */
export const GUTTER = 8;
const FONT = "'PingFang SC', 'Microsoft YaHei', 'Source Han Sans', 'Noto Sans CJK', sans-serif";

/** 一张图的开头。height 是这一行的高度,给宿主的框也用这个数;宽度宿主不从图里读,这里只管内容怎么摆。 */
export const svgOf = (height: number) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${-GUTTER} 0 ${WIDTH + 2 * GUTTER} ${height}" width="${WIDTH + 2 * GUTTER}" height="${height}" role="img" font-family="${FONT}">`;
