/**
 * 把 VPet 的 PNG 序列帧动画转成 dsh-pet 的 webm 素材。
 *
 * 用法：
 *   node scripts/import-vpet-anim.mjs \
 *     --src "E:/SteamLibrary/steamapps/common/VPet/mod/0000_core/pet/vup/Think/Nomal/B" \
 *     --prefix "" \
 *     --name "思考" \
 *     --out "E:/DSH-Data/dsh-home/dsh-pet/webm"
 *
 * 约定（来自 VPet 素材命名）：`<前缀>_NNN_125.png`，125 = 每帧显示毫秒数，
 * 序号从 000 连续。转出的目标规格对齐 dsh-pet：640×360、VP9、带 alpha 通道。
 *
 * 缩放：VPet 原图 1000×1000，先等比缩到 360 高，再居中补边到 640×360，
 * 左右留透明，避免裁掉人物。
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const src = arg('--src');
const prefix = arg('--prefix', '');
const name = arg('--name');
const outDir = arg('--out');

if (!src || !name || !outDir) {
  console.error('缺少参数：--src / --name / --out 必填');
  process.exit(1);
}

// 从第一个匹配帧解析出帧间隔（毫秒）与序号位数
const files = readdirSync(src).filter((f) => /\.png$/i.test(f)).sort();
if (files.length === 0) {
  console.error('源目录没有 PNG 帧：', src);
  process.exit(1);
}
const match = /_(\d{3})_(\d+)\.png$/i.exec(files[0]);
if (!match) {
  console.error('帧命名不符合 <前缀>_NNN_125.png：', files[0]);
  process.exit(1);
}
const frameMs = Number(match[2]);
const fps = Math.round(1000 / frameMs);
const pattern = join(resolve(src), `${prefix}_%03d_${frameMs}.png`);

mkdirSync(resolve(outDir), { recursive: true });
const outFile = join(resolve(outDir), `${name}.webm`);

const vf =
  "scale=360:360:force_original_aspect_ratio=decrease," +
  "pad=640:360:(ow-iw)/2:(oh-ih)/2:color=0x00000000";

const args = [
  '-y',
  '-framerate', String(fps),
  '-start_number', '0',
  '-i', pattern,
  '-vf', vf,
  '-c:v', 'libvpx-vp9',
  '-pix_fmt', 'yuva420p',
  '-crf', '30',
  '-b:v', '0',
  outFile,
];

console.log(`转码 ${files.length} 帧 @ ${fps}fps（每帧 ${frameMs}ms）→ ${outFile}`);
execFileSync('ffmpeg', args, { stdio: 'inherit' });
console.log('完成：', outFile);
