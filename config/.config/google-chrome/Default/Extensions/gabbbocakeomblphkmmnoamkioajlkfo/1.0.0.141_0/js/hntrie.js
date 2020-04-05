/*******************************************************************************

    uBlock Origin - a browser extension to block requests.
    Copyright (C) 2017-present Raymond Hill

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with this program.  If not, see {http://www.gnu.org/licenses/}.

    Home: https://github.com/gorhill/uBlock
*/

/* globals WebAssembly */

'use strict';

// *****************************************************************************
// start of local namespace

{

/*******************************************************************************

  The original prototype was to develop an idea I had about using jump indices
  in a TypedArray for quickly matching hostnames (or more generally strings)[1].
  Once I had a working, un-optimized prototype, I realized I had ended up
  with something formally named a "trie": <https://en.wikipedia.org/wiki/Trie>,
  hence the name. I have no idea whether the implementation here or one
  resembling it has been done elsewhere.

  "HN" in HNTrieContainer stands for "HostName", because the trie is
  specialized to deal with matching hostnames -- which is a bit more
  complicated than matching plain strings.

  For example, `www.abc.com` is deemed matching `abc.com`, because the former
  is a subdomain of the latter. The opposite is of course not true.

  The resulting read-only tries created as a result of using HNTrieContainer
  are simply just typed arrays filled with integers. The matching algorithm is
  just a matter of reading/comparing these integers, and further using them as
  indices in the array as a way to move around in the trie.

  [1] To solve <https://github.com/gorhill/uBlock/issues/3193>

  Since this trie is specialized for matching hostnames, the stored
  strings are reversed internally, because of hostname comparison logic:

  Correct matching:
    index      0123456
               abc.com
                     |
           www.abc.com
    index  01234567890

  Incorrect matching (typically used for plain strings):
    index  0123456
           abc.com
           |
           www.abc.com
    index  01234567890

  ------------------------------------------------------------------------------

  1st iteration:
    - https://github.com/gorhill/uBlock/blob/ff58107dac3a32607f8113e39ed5015584506813/src/js/hntrie.js
    - Suitable for small to medium set of hostnames
    - One buffer per trie

  2nd iteration: goal was to make matches() method wasm-able
    - https://github.com/gorhill/uBlock/blob/c3b0fd31f64bd7ffecdd282fb1208fe07aac3eb0/src/js/hntrie.js
    - Suitable for small to medium set of hostnames
    - Distinct tries all share same buffer:
      - Reduced memory footprint
        - https://stackoverflow.com/questions/45803829/memory-overhead-of-typed-arrays-vs-strings/45808835#45808835
      - Reusing needle character lookups for all tries
        - This significantly reduce the number of String.charCodeAt() calls
    - Slightly improved creation time

  This is the 3rd iteration: goal was to make add() method wasm-able and
  further improve memory/CPU efficiency.

  This 3rd iteration has the following new traits:
    - Suitable for small to large set of hostnames
    - Support multiple trie containers (instanciable)
    - Designed to hold large number of hostnames
    - Hostnames can be added at any time (instead of all at once)
      - This means pre-sorting is no longer a requirement
    - The trie is always compact
      - There is no longer a need for a `vacuum` method
      - This makes the add() method wasm-able
    - It can return the exact hostname which caused the match
    - serializable/unserializable available for fast loading
    - Distinct trie reference support the iteration protocol, thus allowing
      to extract all the hostnames in the trie

  Its primary purpose is to replace the use of Set() as a mean to hold
  large number of hostnames (ex. FilterHostnameDict in static filtering
  engine).

  A HNTrieContainer is mostly a large buffer in which distinct but related
  tries are stored. The memory layout of the buffer is as follow:

    0-254: needle being processed
      255: length of needle
  256-259: offset to start of trie data section (=> trie0)
  260-263: offset to end of trie data section (=> trie1)
  264-267: offset to start of character data section  (=> char0)
  268-271: offset to end of character data section (=> char1)
      272: start of trie data section

*/

const PAGE_SIZE   = 65536;
                                            // i32 /  i8
const TRIE0_SLOT  = 256 >>> 2;              //  64 / 256
const TRIE1_SLOT  = TRIE0_SLOT + 1;         //  65 / 260
const CHAR0_SLOT  = TRIE0_SLOT + 2;         //  66 / 264
const CHAR1_SLOT  = TRIE0_SLOT + 3;         //  67 / 268
const TRIE0_START = TRIE0_SLOT + 4 << 2;    //       272

const HNTrieContainer = class {

    constructor(details) {
        if ( details instanceof Object === false ) { details = {}; }
        let len = (details.byteLength || 0) + PAGE_SIZE-1 & ~(PAGE_SIZE-1);
        this.buf = new Uint8Array(Math.max(len, 131072));
        this.buf32 = new Uint32Array(this.buf.buffer);
        this.needle = '';
        this.buf32[TRIE0_SLOT] = TRIE0_START;
        this.buf32[TRIE1_SLOT] = this.buf32[TRIE0_SLOT];
        this.buf32[CHAR0_SLOT] = details.char0 || 65536;
        this.buf32[CHAR1_SLOT] = this.buf32[CHAR0_SLOT];
        this.wasmInstancePromise = null;
        this.wasmMemory = null;
        this.readyToUse();
    }

    //--------------------------------------------------------------------------
    // Public methods
    //--------------------------------------------------------------------------

    reset() {
        this.buf32[TRIE1_SLOT] = this.buf32[TRIE0_SLOT];
        this.buf32[CHAR1_SLOT] = this.buf32[CHAR0_SLOT];
    }

    readyToUse() {
        if ( HNTrieContainer.wasmModulePromise instanceof Promise === false ) {
            return Promise.resolve();
        }
        return HNTrieContainer.wasmModulePromise.then(
            module => this.initWASM(module)
        );
    }

    setNeedle(needle) {
        if ( needle !== this.needle ) {
            const buf = this.buf;
            let i = needle.length;
            if ( i > 255 ) { i = 255; }
            buf[255] = i;
            while ( i-- ) {
                buf[i] = needle.charCodeAt(i);
            }
            this.needle = needle;
        }
        return this;
    }

    matchesJS(iroot) {
        const buf32 = this.buf32;
        const buf8 = this.buf;
        const char0 = buf32[CHAR0_SLOT];
        let ineedle = buf8[255];
        let icell = buf32[iroot+0];
        if ( icell === 0 ) { return -1; }
        for (;;) {
            if ( ineedle === 0 ) { return -1; }
            ineedle -= 1;
            let c = buf8[ineedle];
            let v, i0;
            // find first segment with a first-character match
            for (;;) {
                v = buf32[icell+2];
                i0 = char0 + (v & 0x00FFFFFF);
                if ( buf8[i0] === c ) { break; }
                icell = buf32[icell+0];
                if ( icell === 0 ) { return -1; }
            }
            // all characters in segment must match
            let n = v >>> 24;
            if ( n > 1 ) {
                n -= 1;
                if ( n > ineedle ) { return -1; }
                i0 += 1;
                const i1 = i0 + n;
                do {
                    ineedle -= 1;
                    if ( buf8[i0] !== buf8[ineedle] ) { return -1; }
                    i0 += 1;
                } while ( i0 < i1 );
            }
            // next segment
            icell = buf32[icell+1];
            if ( icell === 0 ) { break; }
            if ( buf32[icell+2] === 0 ) {
                if ( ineedle === 0 || buf8[ineedle-1] === 0x2E ) {
                    return ineedle;
                }
                icell = buf32[icell+1];
            }
        }
        return ineedle === 0 || buf8[ineedle-1] === 0x2E ? ineedle : -1;
    }

    createOne(args) {
        if ( Array.isArray(args) ) {
            return new this.HNTrieRef(this, args[0], args[1]);
        }
        // grow buffer if needed
        if ( (this.buf32[CHAR0_SLOT] - this.buf32[TRIE1_SLOT]) < 12 ) {
            this.growBuf(12, 0);
        }
        const iroot = this.buf32[TRIE1_SLOT] >>> 2;
        this.buf32[TRIE1_SLOT] += 12;
        this.buf32[iroot+0] = 0;
        this.buf32[iroot+1] = 0;
        this.buf32[iroot+2] = 0;
        return new this.HNTrieRef(this, iroot, 0);
    }

    compileOne(trieRef) {
        return [ trieRef.iroot, trieRef.size ];
    }

    addJS(iroot) {
        let lhnchar = this.buf[255];
        if ( lhnchar === 0 ) { return 0; }
        // grow buffer if needed
        if (
            (this.buf32[CHAR0_SLOT] - this.buf32[TRIE1_SLOT]) < 24 ||
            (this.buf.length - this.buf32[CHAR1_SLOT]) < 256
        ) {
            this.growBuf(24, 256);
        }
        let icell = this.buf32[iroot+0];
        // special case: first node in trie
        if ( icell === 0 ) {
            this.buf32[iroot+0] = this.addCell(0, 0, this.addSegment(lhnchar));
            return 1;
        }
        //
        const char0 = this.buf32[CHAR0_SLOT];
        let inext;
        // find a matching cell: move down
        for (;;) {
            const vseg = this.buf32[icell+2];
            // skip boundary cells
            if ( vseg === 0 ) {
                // remainder is at label boundary? if yes, no need to add
                // the rest since the shortest match is always reported
                if ( this.buf[lhnchar-1] === 0x2E /* '.' */ ) { return -1; }
                icell = this.buf32[icell+1];
                continue;
            }
            let isegchar0 = char0 + (vseg & 0x00FFFFFF);
            // if first character is no match, move to next descendant
            if ( this.buf[isegchar0] !== this.buf[lhnchar-1] ) {
                inext = this.buf32[icell+0];
                if ( inext === 0 ) {
                    this.buf32[icell+0] = this.addCell(0, 0, this.addSegment(lhnchar));
                    return 1;
                }
                icell = inext;
                continue;
            }
            // 1st character was tested
            let isegchar = 1;
            lhnchar -= 1;
            // find 1st mismatch in rest of segment
            const lsegchar = vseg >>> 24;
            if ( lsegchar !== 1 ) {
                for (;;) {
                    if ( isegchar === lsegchar ) { break; }
                    if ( lhnchar === 0 ) { break; }
                    if ( this.buf[isegchar0+isegchar] !== this.buf[lhnchar-1] ) { break; }
                    isegchar += 1;
                    lhnchar -= 1;
                }
            }
            // all segment characters matched
            if ( isegchar === lsegchar ) {
                inext = this.buf32[icell+1];
                // needle remainder: no
                if ( lhnchar === 0 ) {
                    // boundary cell already present
                    if ( inext === 0 || this.buf32[inext+2] === 0 ) { return 0; }
                    // need boundary cell
                    this.buf32[icell+1] = this.addCell(0, inext, 0);
                }
                // needle remainder: yes
                else {
                    if ( inext !== 0 ) {
                        icell = inext;
                        continue;
                    }
                    // remainder is at label boundary? if yes, no need to add
                    // the rest since the shortest match is always reported
                    if ( this.buf[lhnchar-1] === 0x2E /* '.' */ ) { return -1; }
                    // boundary cell + needle remainder
                    inext = this.addCell(0, 0, 0);
                    this.buf32[icell+1] = inext;
                    this.buf32[inext+1] = this.addCell(0, 0, this.addSegment(lhnchar));
                }
            }
            // some segment characters matched
            else {
                // split current cell
                isegchar0 -= char0;
                this.buf32[icell+2] = isegchar << 24 | isegchar0;
                inext = this.addCell(
                    0,
                    this.buf32[icell+1],
                    lsegchar - isegchar << 24 | isegchar0 + isegchar
                );
                this.buf32[icell+1] = inext;
                // needle remainder: no = need boundary cell
                if ( lhnchar === 0 ) {
                    this.buf32[icell+1] = this.addCell(0, inext, 0);
                }
                // needle remainder: yes = need new cell for remaining characters
                else {
                    this.buf32[inext+0] = this.addCell(0, 0, this.addSegment(lhnchar));
                }
            }
            return 1;
        }
    }

    optimize() {
        this.shrinkBuf();
        return {
            byteLength: this.buf.byteLength,
            char0: this.buf32[CHAR0_SLOT],
        };
    }

    fromIterable(hostnames, add) {
        if ( add === undefined ) { add = 'add'; }
        const trieRef = this.createOne();
        for ( const hn of hostnames ) {
            trieRef[add](hn);
        }
        return trieRef;
    }

    serialize(encoder) {
        if ( encoder instanceof Object ) {
            return encoder.encode(
                this.buf32.buffer,
                this.buf32[CHAR1_SLOT]
            );
        }
        return Array.from(
            new Uint32Array(
                this.buf32.buffer,
                0,
                this.buf32[CHAR1_SLOT] + 3 >>> 2
            )
        );
    }

    unserialize(selfie, decoder) {
        this.needle = '';
        const shouldDecode = typeof selfie === 'string';
        let byteLength = shouldDecode
            ? decoder.decodeSize(selfie)
            : selfie.length << 2;
        if ( byteLength === 0 ) { return false; }
        byteLength = byteLength + PAGE_SIZE-1 & ~(PAGE_SIZE-1);
        if ( this.wasmMemory !== null ) {
            const pageCountBefore = this.buf.length >>> 16;
            const pageCountAfter = byteLength >>> 16;
            if ( pageCountAfter > pageCountBefore ) {
                this.wasmMemory.grow(pageCountAfter - pageCountBefore);
                this.buf = new Uint8Array(this.wasmMemory.buffer);
                this.buf32 = new Uint32Array(this.buf.buffer);
            }
        } else if ( byteLength > this.buf.length ) {
            this.buf = new Uint8Array(byteLength);
            this.buf32 = new Uint32Array(this.buf.buffer);
        }
        if ( shouldDecode ) {
            decoder.decode(selfie, this.buf.buffer);
        } else {
            this.buf32.set(selfie);
        }
        return true;
    }

    //--------------------------------------------------------------------------
    // Private methods
    //--------------------------------------------------------------------------

    addCell(idown, iright, v) {
        let icell = this.buf32[TRIE1_SLOT];
        this.buf32[TRIE1_SLOT] = icell + 12;
        icell >>>= 2;
        this.buf32[icell+0] = idown;
        this.buf32[icell+1] = iright;
        this.buf32[icell+2] = v;
        return icell;
    }

    addSegment(lsegchar) {
        if ( lsegchar === 0 ) { return 0; }
        let char1 = this.buf32[CHAR1_SLOT];
        const isegchar = char1 - this.buf32[CHAR0_SLOT];
        let i = lsegchar;
        do {
            this.buf[char1++] = this.buf[--i];
        } while ( i !== 0 );
        this.buf32[CHAR1_SLOT] = char1;
        return (lsegchar << 24) | isegchar;
    }

    growBuf(trieGrow, charGrow) {
        const char0 = Math.max(
            (this.buf32[TRIE1_SLOT] + trieGrow + PAGE_SIZE-1) & ~(PAGE_SIZE-1),
            this.buf32[CHAR0_SLOT]
        );
        const char1 = char0 + this.buf32[CHAR1_SLOT] - this.buf32[CHAR0_SLOT];
        const bufLen = Math.max(
            (char1 + charGrow + PAGE_SIZE-1) & ~(PAGE_SIZE-1),
            this.buf.length
        );
        this.resizeBuf(bufLen, char0);
    }

    shrinkBuf() {
        // Can't shrink WebAssembly.Memory
        if ( this.wasmMemory !== null ) { return; }
        const char0 = this.buf32[TRIE1_SLOT] + 24;
        const char1 = char0 + this.buf32[CHAR1_SLOT] - this.buf32[CHAR0_SLOT];
        const bufLen = char1 + 256;
        this.resizeBuf(bufLen, char0);
    }

    resizeBuf(bufLen, char0) {
        bufLen = bufLen + PAGE_SIZE-1 & ~(PAGE_SIZE-1);
        if (
            bufLen === this.buf.length &&
            char0 === this.buf32[CHAR0_SLOT]
        ) {
            return;
        }
        const charDataLen = this.buf32[CHAR1_SLOT] - this.buf32[CHAR0_SLOT];
        if ( this.wasmMemory !== null ) {
            const pageCount = (bufLen >>> 16) - (this.buf.byteLength >>> 16);
            if ( pageCount > 0 ) {
                this.wasmMemory.grow(pageCount);
                this.buf = new Uint8Array(this.wasmMemory.buffer);
                this.buf32 = new Uint32Array(this.wasmMemory.buffer);
            }
        } else if ( bufLen !== this.buf.length ) {
            const newBuf = new Uint8Array(bufLen);
            newBuf.set(
                new Uint8Array(
                    this.buf.buffer,
                    0,
                    this.buf32[TRIE1_SLOT]
                ),
                0
            );
            newBuf.set(
                new Uint8Array(
                    this.buf.buffer,
                    this.buf32[CHAR0_SLOT],
                    charDataLen
                ),
                char0
            );
            this.buf = newBuf;
            this.buf32 = new Uint32Array(this.buf.buffer);
            this.buf32[CHAR0_SLOT] = char0;
            this.buf32[CHAR1_SLOT] = char0 + charDataLen;
        }
        if ( char0 !== this.buf32[CHAR0_SLOT] ) {
            this.buf.set(
                new Uint8Array(
                    this.buf.buffer,
                    this.buf32[CHAR0_SLOT],
                    charDataLen
                ),
                char0
            );
            this.buf32[CHAR0_SLOT] = char0;
            this.buf32[CHAR1_SLOT] = char0 + charDataLen;
        }
    }

    initWASM(module) {
        if ( module instanceof WebAssembly.Module === false ) {
            return Promise.resolve(null);
        }
        if ( this.wasmInstancePromise === null ) {
            const memory = new WebAssembly.Memory({ initial: 2 });
            this.wasmInstancePromise = WebAssembly.instantiate(
                module,
                {
                    imports: {
                        memory,
                        growBuf: this.growBuf.bind(this, 24, 256)
                    }
                }
            );
            this.wasmInstancePromise.then(instance => {
                this.wasmMemory = memory;
                const curPageCount = memory.buffer.byteLength >>> 16;
                const newPageCount = this.buf.byteLength + PAGE_SIZE-1 >>> 16;
                if ( newPageCount > curPageCount ) {
                    memory.grow(newPageCount - curPageCount);
                }
                const buf = new Uint8Array(memory.buffer);
                buf.set(this.buf);
                this.buf = buf;
                this.buf32 = new Uint32Array(this.buf.buffer);
                this.matches = this.matchesWASM = instance.exports.matches;
                this.add = this.addWASM = instance.exports.add;
            });
        }
        return this.wasmInstancePromise;
    }
};

HNTrieContainer.prototype.matches = HNTrieContainer.prototype.matchesJS;
HNTrieContainer.prototype.matchesWASM = null;

HNTrieContainer.prototype.add = HNTrieContainer.prototype.addJS;
HNTrieContainer.prototype.addWASM = null;

/*******************************************************************************

    Class to hold reference to a specific trie

*/

HNTrieContainer.prototype.HNTrieRef = class {

    constructor(container, iroot, size) {
        this.container = container;
        this.iroot = iroot;
        this.size = size;
        this.needle = '';
        this.last = -1;
    }

    add(hn) {
        if ( this.container.setNeedle(hn).add(this.iroot) > 0 ) {
            this.last = -1;
            this.needle = '';
            this.size += 1;
            return true;
        }
        return false;
    }

    addJS(hn) {
        if ( this.container.setNeedle(hn).addJS(this.iroot) > 0 ) {
            this.last = -1;
            this.needle = '';
            this.size += 1;
            return true;
        }
        return false;
    }

    addWASM(hn) {
        if ( this.container.setNeedle(hn).addWASM(this.iroot) > 0 ) {
            this.last = -1;
            this.needle = '';
            this.size += 1;
            return true;
        }
        return false;
    }

    matches(needle) {
        if ( needle !== this.needle ) {
            this.needle = needle;
            this.last = this.container.setNeedle(needle).matches(this.iroot);
        }
        return this.last;
    }

    matchesJS(needle) {
        if ( needle !== this.needle ) {
            this.needle = needle;
            this.last = this.container.setNeedle(needle).matchesJS(this.iroot);
        }
        return this.last;
    }

    matchesWASM(needle) {
        if ( needle !== this.needle ) {
            this.needle = needle;
            this.last = this.container.setNeedle(needle).matchesWASM(this.iroot);
        }
        return this.last;
    }

    dump() {
        let hostnames = Array.from(this);
        if ( String.prototype.padStart instanceof Function ) {
            const maxlen = Math.min(
                hostnames.reduce((maxlen, hn) => Math.max(maxlen, hn.length), 0),
                64
            );
            hostnames = hostnames.map(hn => hn.padStart(maxlen));
        }
        for ( const hn of hostnames ) {
            console.log(hn);
        }
    }

    [Symbol.iterator]() {
        return {
            value: undefined,
            done: false,
            next: function() {
                if ( this.icell === 0 ) {
                    if ( this.forks.length === 0 ) {
                        this.value = undefined;
                        this.done = true;
                        return this;
                    }
                    this.charPtr = this.forks.pop();
                    this.icell = this.forks.pop();
                }
                for (;;) {
                    const idown = this.container.buf32[this.icell+0];
                    if ( idown !== 0 ) {
                        this.forks.push(idown, this.charPtr);
                    }
                    const v = this.container.buf32[this.icell+2];
                    let i0 = this.container.buf32[CHAR0_SLOT] + (v & 0x00FFFFFF);
                    const i1 = i0 + (v >>> 24);
                    while ( i0 < i1 ) {
                        this.charPtr -= 1;
                        this.charBuf[this.charPtr] = this.container.buf[i0];
                        i0 += 1;
                    }
                    this.icell = this.container.buf32[this.icell+1];
                    if ( this.icell === 0 ) {
                        return this.toHostname();
                    }
                    if ( this.container.buf32[this.icell+2] === 0 ) {
                        this.icell = this.container.buf32[this.icell+1];
                        return this.toHostname();
                    }
                }
            },
            toHostname: function() {
                this.value = this.textDecoder.decode(
                    new Uint8Array(this.charBuf.buffer, this.charPtr)
                );
                return this;
            },
            container: this.container,
            icell: this.iroot,
            charBuf: new Uint8Array(256),
            charPtr: 256,
            forks: [],
            textDecoder: new TextDecoder()
        };
    }
};

HNTrieContainer.prototype.HNTrieRef.prototype.last = -1;
HNTrieContainer.prototype.HNTrieRef.prototype.needle = '';

/******************************************************************************/

// Code below is to attempt to load a WASM module which implements:
//
// - HNTrieContainer.add()
// - HNTrieContainer.matches()
//
// The WASM module is entirely optional, the JS implementations will be
// used should the WASM module be unavailable for whatever reason.

(( ) => {
    HNTrieContainer.wasmModulePromise = null;

    if (
        typeof WebAssembly !== 'object' ||
        typeof WebAssembly.compileStreaming !== 'function'
    ) {
        return;
    }

    // Soft-dependency on vAPI so that the code here can be used outside of
    // uBO (i.e. tests, benchmarks)
    if ( typeof vAPI === 'object' && vAPI.canWASM !== true ) { return; }

    // Soft-dependency on µBlock's advanced settings so that the code here can
    // be used outside of uBO (i.e. tests, benchmarks)
    if (
        typeof µBlock === 'object' &&
        µBlock.hiddenSettings.disableWebAssembly === true
    ) {
        return;
    }

    // The wasm module will work only if CPU is natively little-endian,
    // as we use native uint32 array in our js code.
    const uint32s = new Uint32Array(1);
    const uint8s = new Uint8Array(uint32s.buffer);
    uint32s[0] = 1;
    if ( uint8s[0] !== 1 ) { return; }

    // The directory from which the current script was fetched should also
    // contain the related WASM file. The script is fetched from a trusted
    // location, and consequently so will be the related WASM file.
    let workingDir;
    {
        const url = new URL(document.currentScript.src);
        const match = /[^\/]+$/.exec(url.pathname);
        if ( match !== null ) {
            url.pathname = url.pathname.slice(0, match.index);
        }
        workingDir = url.href;
    }

    HNTrieContainer.wasmModulePromise = fetch(
        workingDir + 'wasm/hntrie.wasm',
        { mode: 'same-origin' }
    ).then(
        WebAssembly.compileStreaming
    ).catch(reason => {
        HNTrieContainer.wasmModulePromise = null;
        log.info(reason);
    });
})();

/******************************************************************************/

µBlock.HNTrieContainer = HNTrieContainer;

// end of local namespace
// *****************************************************************************

}
