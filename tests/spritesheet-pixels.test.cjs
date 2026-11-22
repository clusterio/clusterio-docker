const {test} = require("node:test");
const assert = require("node:assert/strict");
const zlib = require("node:zlib");
const {nonBlankBytes} = require("./spritesheet-pixels.cjs");

function crc32(buf) {
	let crc = ~0;
	for (const byte of buf) {
		crc ^= byte;
		for (let k = 0; k < 8; k++) { crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1; }
	}
	return ~crc >>> 0;
}
function chunk(type, data) {
	const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
	const head = Buffer.alloc(4); head.writeUInt32BE(data.length);
	const tail = Buffer.alloc(4); tail.writeUInt32BE(crc32(body));
	return Buffer.concat([head, body, tail]);
}
function paeth(a, b, c) {
	const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
	return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}
// Encodes RGBA rows with one PNG filter type for every scanline.
function encode(rows, filter, {interlace = 0} = {}) {
	const width = rows[0].length / 4, bpp = 4;
	const lines = rows.map((raw, y) => {
		const out = Buffer.alloc(raw.length + 1);
		out[0] = filter;
		for (let i = 0; i < raw.length; i++) {
			const left = i >= bpp ? raw[i - bpp] : 0;
			const up = y ? rows[y - 1][i] : 0;
			const upLeft = y && i >= bpp ? rows[y - 1][i - bpp] : 0;
			const predictor = [0, left, up, (left + up) >> 1, paeth(left, up, upLeft)][filter];
			out[i + 1] = (raw[i] - predictor) & 0xff;
		}
		return out;
	});
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(rows.length, 4);
	ihdr[8] = 8; ihdr[9] = 6; ihdr[12] = interlace;
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(Buffer.concat(lines))), chunk("IEND", Buffer.alloc(0)),
	]);
}

const blank = Array.from({length: 6}, () => Buffer.alloc(8 * 4));
// Deterministic non-blank pixels, including runs of equal neighbours so that the
// filtered stream contains zeros where the pixels do not.
const picture = Array.from({length: 6}, (_, y) => Buffer.from(
	Array.from({length: 8 * 4}, (_, i) => (y < 2 ? 0 : ((i >> 2) % 3 === 0 ? 0 : 40 + 7 * y + (i % 4)) & 0xff))
));
const expected = picture.reduce((sum, row) => sum + row.filter(Boolean).length, 0);

test("a blank image counts 0 whichever filter the encoder chose", () => {
	for (const filter of [0, 1, 2, 3, 4]) {
		assert.equal(nonBlankBytes(encode(blank, filter)), 0, `filter ${filter}`);
	}
});

test("the count is of pixels, not of the filtered stream", () => {
	assert.ok(expected > 0);
	for (const filter of [0, 1, 2, 3, 4]) {
		assert.equal(nonBlankBytes(encode(picture, filter)), expected, `filter ${filter}`);
	}
});

test("unsupported or broken input fails instead of reporting a count", () => {
	assert.throws(() => nonBlankBytes(Buffer.from("not a png at all")), /not a PNG/);
	assert.throws(() => nonBlankBytes(encode(blank, 0, {interlace: 1})), /interlaced/);
	assert.throws(() => nonBlankBytes(encode(blank, 5)), /filter type 5/);
});
