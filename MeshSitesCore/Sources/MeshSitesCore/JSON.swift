/// A strict JSON parser and the canonical encoder from SPEC §3.
///
/// Numbers follow JavaScript: an integral value within ±(2^53-1) is `.int`,
/// whether written `12`, `12.0` or `1.2e1`; anything else is `.double`. Duplicate
/// keys keep the last value, as JSON.parse does.
public indirect enum JSON: Equatable {
    case null
    case bool(Bool)
    case int(Int64)
    case double(Double)
    case string(String)
    case array([JSON])
    case object([String: JSON])

    public subscript(key: String) -> JSON? {
        if case .object(let o) = self { return o[key] }
        return nil
    }

    public var string: String? { if case .string(let s) = self { return s }; return nil }
    public var int: Int64? { if case .int(let i) = self { return i }; return nil }
    public var array: [JSON]? { if case .array(let a) = self { return a }; return nil }
    public var object: [String: JSON]? { if case .object(let o) = self { return o }; return nil }
}

public enum JSONError: Error, Equatable, CustomStringConvertible {
    case syntax(String)
    case canonical(String)
    public var description: String {
        switch self {
        case .syntax(let s): return "JSON syntax: \(s)"
        case .canonical(let s): return "canonical JSON: \(s)"
        }
    }
}

public let maxSafeInteger: Int64 = 9_007_199_254_740_991

extension JSON {
    public static func parse(_ text: String) throws -> JSON {
        try parse(Array(text.utf8))
    }

    public static func parse(_ bytes: Bytes) throws -> JSON {
        var p = Parser(b: bytes)
        p.ws()
        let v = try p.value(depth: 0)
        p.ws()
        guard p.i == bytes.count else { throw JSONError.syntax("trailing characters") }
        return v
    }

    private struct Parser {
        let b: Bytes
        var i = 0

        mutating func ws() {
            while i < b.count, [0x20, 0x09, 0x0a, 0x0d].contains(b[i]) { i += 1 }
        }

        mutating func expect(_ s: String) throws {
            let u = Array(s.utf8)
            guard i + u.count <= b.count, Array(b[i..<(i + u.count)]) == u else { throw JSONError.syntax("expected \(s)") }
            i += u.count
        }

        mutating func value(depth: Int) throws -> JSON {
            guard depth < 64 else { throw JSONError.syntax("nested too deep") }
            guard i < b.count else { throw JSONError.syntax("unexpected end") }
            switch b[i] {
            case UInt8(ascii: "{"):
                i += 1
                var o: [String: JSON] = [:]
                ws()
                if i < b.count, b[i] == UInt8(ascii: "}") { i += 1; return .object(o) }
                while true {
                    ws()
                    guard i < b.count, b[i] == UInt8(ascii: "\"") else { throw JSONError.syntax("expected key") }
                    let k = try string()
                    ws()
                    try expect(":")
                    ws()
                    o[k] = try value(depth: depth + 1)
                    ws()
                    guard i < b.count else { throw JSONError.syntax("unexpected end") }
                    if b[i] == UInt8(ascii: ",") { i += 1; continue }
                    if b[i] == UInt8(ascii: "}") { i += 1; return .object(o) }
                    throw JSONError.syntax("expected , or }")
                }
            case UInt8(ascii: "["):
                i += 1
                var a: [JSON] = []
                ws()
                if i < b.count, b[i] == UInt8(ascii: "]") { i += 1; return .array(a) }
                while true {
                    ws()
                    a.append(try value(depth: depth + 1))
                    ws()
                    guard i < b.count else { throw JSONError.syntax("unexpected end") }
                    if b[i] == UInt8(ascii: ",") { i += 1; continue }
                    if b[i] == UInt8(ascii: "]") { i += 1; return .array(a) }
                    throw JSONError.syntax("expected , or ]")
                }
            case UInt8(ascii: "\""): return .string(try string())
            case UInt8(ascii: "t"): try expect("true"); return .bool(true)
            case UInt8(ascii: "f"): try expect("false"); return .bool(false)
            case UInt8(ascii: "n"): try expect("null"); return .null
            default: return try number()
            }
        }

        mutating func number() throws -> JSON {
            let start = i
            func digits() -> Int {
                let s = i
                while i < b.count, b[i] >= 0x30, b[i] <= 0x39 { i += 1 }
                return i - s
            }
            if i < b.count, b[i] == UInt8(ascii: "-") { i += 1 }
            guard i < b.count else { throw JSONError.syntax("bad number") }
            if b[i] == UInt8(ascii: "0") { i += 1 } else { guard digits() > 0 else { throw JSONError.syntax("bad number") } }
            var isInt = true
            if i < b.count, b[i] == UInt8(ascii: ".") { i += 1; isInt = false; guard digits() > 0 else { throw JSONError.syntax("bad number") } }
            if i < b.count, b[i] == UInt8(ascii: "e") || b[i] == UInt8(ascii: "E") {
                i += 1
                isInt = false
                if i < b.count, b[i] == UInt8(ascii: "+") || b[i] == UInt8(ascii: "-") { i += 1 }
                guard digits() > 0 else { throw JSONError.syntax("bad number") }
            }
            let text = String(decoding: b[start..<i], as: UTF8.self)
            if isInt, let v = Int64(text) { return .int(v) }
            guard let d = Double(text) else { throw JSONError.syntax("bad number") }
            if d.rounded() == d, abs(d) <= Double(maxSafeInteger) { return .int(Int64(d)) }
            return .double(d)
        }

        mutating func hex4() throws -> UInt32 {
            guard i + 4 <= b.count, let h = Hex.decode(String(decoding: b[i..<(i + 4)], as: UTF8.self)) else { throw JSONError.syntax("bad \\u escape") }
            i += 4
            return UInt32(h[0]) << 8 | UInt32(h[1])
        }

        mutating func string() throws -> String {
            i += 1 // opening quote
            var scalars = String.UnicodeScalarView()
            var raw = Bytes()
            func flush() throws {
                if raw.isEmpty { return }
                guard let s = String(bytes: raw, encoding: .utf8) else { throw JSONError.syntax("invalid UTF-8") }
                scalars.append(contentsOf: s.unicodeScalars)
                raw.removeAll()
            }
            while true {
                guard i < b.count else { throw JSONError.syntax("unterminated string") }
                let c = b[i]
                i += 1
                if c == UInt8(ascii: "\"") { try flush(); return String(scalars) }
                if c < 0x20 { throw JSONError.syntax("control character in string") }
                if c != UInt8(ascii: "\\") { raw.append(c); continue }
                try flush()
                guard i < b.count else { throw JSONError.syntax("bad escape") }
                let e = b[i]
                i += 1
                switch e {
                case UInt8(ascii: "\""): scalars.append("\"")
                case UInt8(ascii: "\\"): scalars.append("\\")
                case UInt8(ascii: "/"): scalars.append("/")
                case UInt8(ascii: "b"): scalars.append("\u{08}")
                case UInt8(ascii: "f"): scalars.append("\u{0C}")
                case UInt8(ascii: "n"): scalars.append("\n")
                case UInt8(ascii: "r"): scalars.append("\r")
                case UInt8(ascii: "t"): scalars.append("\t")
                case UInt8(ascii: "u"):
                    var u = try hex4()
                    if (0xD800...0xDBFF).contains(u) {
                        // A lone surrogate is invalid (JS would accept it, then canonical JSON rejects it).
                        guard i + 6 <= b.count, b[i] == UInt8(ascii: "\\"), b[i + 1] == UInt8(ascii: "u") else { throw JSONError.syntax("lone surrogate") }
                        i += 2
                        let lo = try hex4()
                        guard (0xDC00...0xDFFF).contains(lo) else { throw JSONError.syntax("lone surrogate") }
                        u = 0x10000 + ((u - 0xD800) << 10) + (lo - 0xDC00)
                    } else if (0xDC00...0xDFFF).contains(u) {
                        throw JSONError.syntax("lone surrogate")
                    }
                    guard let s = Unicode.Scalar(u) else { throw JSONError.syntax("bad code point") }
                    scalars.append(s)
                default: throw JSONError.syntax("bad escape")
                }
            }
        }
    }
}

// MARK: - Canonical JSON (SPEC §3)

extension JSON {
    /// Canonical form: sorted ASCII keys, no whitespace, safe integers only,
    /// strings escaped exactly as ECMAScript JSON.stringify does.
    public func canonical() throws -> String {
        var out = ""
        try Self.write(self, &out)
        return out
    }

    static func write(_ v: JSON, _ out: inout String) throws {
        switch v {
        case .null: out += "null"
        case .bool(let b): out += b ? "true" : "false"
        case .int(let n):
            guard n >= -maxSafeInteger, n <= maxSafeInteger else { throw JSONError.canonical("not a safe integer: \(n)") }
            out += String(n)
        case .double(let d): throw JSONError.canonical("not a safe integer: \(d)")
        case .string(let s): out += escape(s)
        case .array(let a):
            out += "["
            for (k, x) in a.enumerated() {
                if k > 0 { out += "," }
                try write(x, &out)
            }
            out += "]"
        case .object(let o):
            out += "{"
            for (k, key) in o.keys.sorted(by: { Array($0.utf8).lexicographicallyPrecedes(Array($1.utf8)) }).enumerated() {
                guard !key.isEmpty, key.utf8.allSatisfy({ ($0 >= 0x30 && $0 <= 0x39) || ($0 >= 0x41 && $0 <= 0x5a) || ($0 >= 0x61 && $0 <= 0x7a) || $0 == 0x5f }) else {
                    throw JSONError.canonical("bad key: \(key)")
                }
                if k > 0 { out += "," }
                out += escape(key) + ":"
                try write(o[key]!, &out)
            }
            out += "}"
        }
    }

    static func escape(_ s: String) -> String {
        var out = "\""
        for u in s.unicodeScalars {
            switch u {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\u{08}": out += "\\b"
            case "\t": out += "\\t"
            case "\n": out += "\\n"
            case "\u{0C}": out += "\\f"
            case "\r": out += "\\r"
            default:
                if u.value < 0x20 {
                    out += "\\u00" + Hex.encode([UInt8(u.value)])
                } else {
                    out.unicodeScalars.append(u)
                }
            }
        }
        return out + "\""
    }
}
