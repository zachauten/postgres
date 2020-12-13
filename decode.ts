import { Oid } from "./oid.ts";
import { Column, Format } from "./connection.ts";
import { parseArray } from "./array_parser.ts";

// Datetime parsing based on:
// https://github.com/bendrucker/postgres-date/blob/master/index.js
const DATETIME_RE =
  /^(\d{1,})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(\.\d{1,})?/;
const DATE_RE = /^(\d{1,})-(\d{2})-(\d{2})$/;
const TIMEZONE_RE = /([Z+-])(\d{2})?:?(\d{2})?:?(\d{2})?/;
const BC_RE = /BC$/;

function decodeDate(dateStr: string): null | Date {
  const matches = DATE_RE.exec(dateStr);

  if (!matches) {
    return null;
  }

  const year = parseInt(matches[1], 10);
  // remember JS dates are 0-based
  const month = parseInt(matches[2], 10) - 1;
  const day = parseInt(matches[3], 10);
  const date = new Date(year, month, day);
  // use `setUTCFullYear` because if date is from first
  // century `Date`'s compatibility for millenium bug
  // would set it as 19XX
  date.setUTCFullYear(year);

  return date;
}
/**
 * Decode numerical timezone offset from provided date string.
 *
 * Matched these kinds:
 * - `Z (UTC)`
 * - `-05`
 * - `+06:30`
 * - `+06:30:10`
 *
 * Returns offset in miliseconds.
 */
function decodeTimezoneOffset(dateStr: string): null | number {
  // get rid of date part as TIMEZONE_RE would match '-MM` part
  const timeStr = dateStr.split(" ")[1];
  const matches = TIMEZONE_RE.exec(timeStr);

  if (!matches) {
    return null;
  }

  const type = matches[1];

  if (type === "Z") {
    // Zulu timezone === UTC === 0
    return 0;
  }

  // in JS timezone offsets are reversed, ie. timezones
  // that are "positive" (+01:00) are represented as negative
  // offsets and vice-versa
  const sign = type === "-" ? 1 : -1;

  const hours = parseInt(matches[2], 10);
  const minutes = parseInt(matches[3] || "0", 10);
  const seconds = parseInt(matches[4] || "0", 10);

  const offset = hours * 3600 + minutes * 60 + seconds;

  return sign * offset * 1000;
}

function decodeDatetime(dateStr: string): null | number | Date {
  /**
   * Postgres uses ISO 8601 style date output by default:
   * 1997-12-17 07:37:16-08
   */

  // there are special `infinity` and `-infinity`
  // cases representing out-of-range dates
  if (dateStr === "infinity") {
    return Number(Infinity);
  } else if (dateStr === "-infinity") {
    return Number(-Infinity);
  }

  const matches = DATETIME_RE.exec(dateStr);

  if (!matches) {
    return decodeDate(dateStr);
  }

  const isBC = BC_RE.test(dateStr);

  const year = parseInt(matches[1], 10) * (isBC ? -1 : 1);
  // remember JS dates are 0-based
  const month = parseInt(matches[2], 10) - 1;
  const day = parseInt(matches[3], 10);
  const hour = parseInt(matches[4], 10);
  const minute = parseInt(matches[5], 10);
  const second = parseInt(matches[6], 10);
  // ms are written as .007
  const msMatch = matches[7];
  const ms = msMatch ? 1000 * parseFloat(msMatch) : 0;

  let date: Date;

  const offset = decodeTimezoneOffset(dateStr);
  if (offset === null) {
    date = new Date(year, month, day, hour, minute, second, ms);
  } else {
    // This returns miliseconds from 1 January, 1970, 00:00:00,
    // adding decoded timezone offset will construct proper date object.
    const utc = Date.UTC(year, month, day, hour, minute, second, ms);
    date = new Date(utc + offset);
  }

  // use `setUTCFullYear` because if date is from first
  // century `Date`'s compatibility for millenium bug
  // would set it as 19XX
  date.setUTCFullYear(year);
  return date;
}

function decodeBinary() {
  throw new Error("Not implemented!");
}

// Ported from https://github.com/brianc/node-pg-types
// The MIT License (MIT)
//
// Copyright (c) 2014 Brian M. Carlson
//
// Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
function decodePoint(value: string): unknown {
  if (value[0] !== "(") return null;

  const [x, y] = value.substring(1, value.length - 1).split(",");

  return {
    x: parseFloat(x),
    y: parseFloat(y),
  };
}

function decodePointArray(value: string): unknown[] {
  return parseArray(value, decodePoint);
}

const HEX = 16;
const BACKSLASH_BYTE_VALUE = 92;
const HEX_PREFIX_REGEX = /^\\x/;

function decodeBytea(byteaStr: string): Uint8Array {
  if (HEX_PREFIX_REGEX.test(byteaStr)) {
    return decodeByteaHex(byteaStr);
  } else {
    return decodeByteaEscape(byteaStr);
  }
}

function decodeByteaHex(byteaStr: string): Uint8Array {
  const bytesStr = byteaStr.slice(2);
  const bytes = new Uint8Array(bytesStr.length / 2);
  for (let i = 0, j = 0; i < bytesStr.length; i += 2, j++) {
    bytes[j] = parseInt(bytesStr[i] + bytesStr[i + 1], HEX);
  }
  return bytes;
}

function decodeByteaEscape(byteaStr: string): Uint8Array {
  const bytes = [];
  let i = 0;
  let k = 0;
  while (i < byteaStr.length) {
    if (byteaStr[i] !== "\\") {
      bytes.push(byteaStr.charCodeAt(i));
      ++i;
    } else {
      if (/[0-7]{3}/.test(byteaStr.substr(i + 1, 3))) {
        bytes.push(parseInt(byteaStr.substr(i + 1, 3), 8));
        i += 4;
      } else {
        let backslashes = 1;
        while (
          i + backslashes < byteaStr.length &&
          byteaStr[i + backslashes] === "\\"
        ) {
          backslashes++;
        }
        for (k = 0; k < Math.floor(backslashes / 2); ++k) {
          bytes.push(BACKSLASH_BYTE_VALUE);
        }
        i += Math.floor(backslashes / 2) * 2;
      }
    }
  }
  return new Uint8Array(bytes);
}

const decoder = new TextDecoder();

// deno-lint-ignore no-explicit-any
function decodeStringArray(value: string): any {
  if (!value) return null;
  return parseArray(value, undefined);
}

function decodeBaseTenInt(value: string): number {
  return parseInt(value, 10);
}

// deno-lint-ignore no-explicit-any
function decodeIntArray(value: string): any {
  if (!value) return null;
  return parseArray(value, decodeBaseTenInt);
}

function decodeJsonArray(value: string): unknown[] {
  return parseArray(value, JSON.parse);
}

function decodeCircle(value: string) {
  const match = value.match(/<\((.+),(.+)\),(.+)>/);
  if (!match) return null;
  return {
    x: parseFloat(match[1]),
    y: parseFloat(match[2]),
    radius: parseFloat(match[3]),
  };
}

function decodeCircleArray(value: string): unknown[] {
  return parseArray(value, decodeCircle);
}

function decodeLineSegment(value: string) {
  const match = value.match(/\[(\(.+\)),(\(.+\))\]/);
  if (!match) return null;
  return [decodePoint(match[1]), decodePoint(match[2])];
}

function decodeLineSegmentArray(value: string) {
  return parseArray(value, decodeLineSegment);
}

// deno-lint-ignore no-explicit-any
function decodeText(value: Uint8Array, typeOid: number): any {
  const strValue = decoder.decode(value);

  switch (typeOid) {
    case Oid.char:
    case Oid.varchar:
    case Oid.text:
    case Oid.time:
    case Oid.timetz:
    case Oid.inet:
    case Oid.cidr:
    case Oid.macaddr:
    case Oid.name:
    case Oid.uuid:
    case Oid.oid:
    case Oid.regproc:
    case Oid.regprocedure:
    case Oid.regoper:
    case Oid.regoperator:
    case Oid.regclass:
    case Oid.regtype:
    case Oid.regrole:
    case Oid.regnamespace:
    case Oid.regconfig:
    case Oid.regdictionary:
    case Oid.int8: // @see https://github.com/buildondata/deno-postgres/issues/91.
    case Oid.numeric:
    case Oid.void:
    case Oid.bpchar:
      return strValue;
    case Oid._text:
    case Oid._varchar:
    case Oid._macaddr:
    case Oid._cidr:
    case Oid._inet:
    case Oid._bpchar:
    case Oid._uuid:
      return decodeStringArray(strValue);
    case Oid.bool:
      return strValue[0] === "t";
    case Oid.int2:
    case Oid.int4:
      return decodeBaseTenInt(strValue);
    case Oid._int2:
    case Oid._int4:
      return decodeIntArray(strValue);
    case Oid.float4:
    case Oid.float8:
      return parseFloat(strValue);
    case Oid.timestamptz:
    case Oid.timestamp:
      return decodeDatetime(strValue);
    case Oid.date:
      return decodeDate(strValue);
    case Oid.json:
    case Oid.jsonb:
      return JSON.parse(strValue);
    case Oid.json_array:
    case Oid.jsonb_array:
      return decodeJsonArray(strValue);
    case Oid.point:
      return decodePoint(strValue);
    case Oid._point:
      return decodePointArray(strValue);
    case Oid.bytea:
      return decodeBytea(strValue);
    case Oid.circle:
      return decodeCircle(strValue);
    case Oid._circle:
      return decodeCircleArray(strValue);
    case Oid.lseg:
      return decodeLineSegment(strValue);
    case Oid._lseg:
      return decodeLineSegmentArray(strValue);
    default:
      throw new Error(`Don't know how to parse column type: ${typeOid}`);
  }
}

export function decode(value: Uint8Array, column: Column) {
  if (column.format === Format.BINARY) {
    return decodeBinary();
  } else if (column.format === Format.TEXT) {
    return decodeText(value, column.typeOid);
  } else {
    throw new Error(`Unknown column format: ${column.format}`);
  }
}
