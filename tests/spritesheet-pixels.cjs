// Counts the non-zero bytes of a PNG's reconstructed pixel data. 0 means the image
// is entirely blank (transparent black), which is what a Clusterio export from a
// host without the Factorio game client produces.
//
// A PNG stores one filter-type byte per scanline next to the pixel bytes, and the
// pixel bytes themselves are stored as differences. Counting non-zero bytes of the
// raw inflated stream would therefore count encoder choices, not pixels — so the
// scanlines are unfiltered first.
//
// requires: node (no packages)
// usage:    node spritesheet-pixels.cjs <file.png>
//           docker exec -i <container> node - <file.png> < tests/spritesheet-pixels.cjs
// produces: the count on stdout; non-zero exit on an unreadable or unsupported PNG
// does not: handle interlaced PNGs (it throws; Clusterio does not write them)
const fs = require("node:fs");
const zlib = require("node:zlib");

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function paeth(a, b, c) {
	const p = a + b - c;
	const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
	if (pa <= pb && pa <= pc) { return a; }
	return pb <= pc ? b : c;
}

function nonBlankBytes(png) {
	if (png.length < 8 || !png.subarray(0, 8).equals(SIGNATURE)) { throw new Error("not a PNG"); }
	let header = null;
	const idat = [];
	for (let offset = 8; offset + 8 <= png.length;) {
		const length = png.readUInt32BE(offset);
		const type = png.toString("ascii", offset + 4, offset + 8);
		const data = png.subarray(offset + 8, offset + 8 + length);
		if (type === "IHDR") {
			header = { width: data.readUInt32BE(0), height: data.readUInt32BE(4), depth: data[8], colour: data[9], interlace: data[12] };
		} else if (type === "IDAT") {
			idat.push(data);
		}
		offset += 12 + length;
	}
	if (!header) { throw new Error("PNG has no IHDR chunk"); }
	if (header.interlace !== 0) { throw new Error("interlaced PNGs are not supported"); }
	const channels = CHANNELS[header.colour];
	if (!channels) { throw new Error(`unknown PNG colour type ${header.colour}`); }

	const bitsPerPixel = channels * header.depth;
	const bytesPerPixel = Math.max(1, bitsPerPixel >> 3);
	const rowBytes = Math.ceil(header.width * bitsPerPixel / 8);
	const stream = zlib.inflateSync(Buffer.concat(idat));
	if (stream.length < header.height * (rowBytes + 1)) { throw new Error("PNG pixel data is truncated"); }

	let count = 0;
	let previous = Buffer.alloc(rowBytes);
	for (let row = 0; row < header.height; row++) {
		const start = row * (rowBytes + 1);
		const filter = stream[start];
		const line = Buffer.from(stream.subarray(start + 1, start + 1 + rowBytes));
		for (let i = 0; i < rowBytes; i++) {
			const left = i >= bytesPerPixel ? line[i - bytesPerPixel] : 0;
			const up = previous[i];
			const upLeft = i >= bytesPerPixel ? previous[i - bytesPerPixel] : 0;
			let predictor;
			switch (filter) {
				case 0: predictor = 0; break;
				case 1: predictor = left; break;
				case 2: predictor = up; break;
				case 3: predictor = (left + up) >> 1; break;
				case 4: predictor = paeth(left, up, upLeft); break;
				default: throw new Error(`unknown PNG filter type ${filter} on row ${row}`);
			}
			line[i] = (line[i] + predictor) & 0xff;
			if (line[i]) { count++; }
		}
		previous = line;
	}
	return count;
}

module.exports = { nonBlankBytes };

// Run as a script: directly, or piped to `node -` (where require.main is unset).
if (require.main === module || require.main === undefined) {
	const file = process.argv[process.argv.length - 1];
	console.log(nonBlankBytes(fs.readFileSync(file)));
}
