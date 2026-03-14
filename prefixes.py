#!/usr/bin/env python3

import argparse
import ipaddress
import json
import sys
import urllib.parse
import urllib.request


COUNTRY_API_URL  = "https://stat.ripe.net/data/country-resource-list/data.json"
ASN_API_URL      = "https://stat.ripe.net/data/announced-prefixes/data.json"


def parse_args():
    parser = argparse.ArgumentParser(
        description="Fetch IPv4 prefixes from RIPEstat and aggregate them.\n"
                    "Source: --country OR --asn / --asn-list (mutually exclusive).",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )

    # ── источник ────────────────────────────────────────────────────────────
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument(
        "-c", "--country",
        metavar="CC",
        help="2-letter ISO country code (e.g. RU, DE, US)"
    )
    source.add_argument(
        "-a", "--asn",
        metavar="ASN",
        type=lambda s: s.lstrip("Aa Ss"),   # принимаем 'AS12345' и '12345'
        help="Single AS number (e.g. AS12345 or 12345)"
    )
    source.add_argument(
        "--asn-list",
        metavar="ASN1,ASN2,...",
        help="Comma-separated list of AS numbers (e.g. 12345,20485,3216)"
    )

    # ── вывод / поведение ────────────────────────────────────────────────────
    parser.add_argument(
        "-o", "--output",
        help="Write aggregated prefixes to output file (default: stdout)"
    )
    parser.add_argument(
        "--timeout",
        type=int,
        default=30,
        help="HTTP timeout in seconds per request (default: 30)"
    )
    parser.add_argument(
        "--strict",
        action="store_true",
        help="Require strict CIDR notation when parsing prefixes"
    )
    parser.add_argument(
        "--quiet",
        action="store_true",
        help="Suppress statistics output"
    )
    parser.add_argument(
        "--stats-only",
        action="store_true",
        help="Show statistics only, do not print aggregated prefixes"
    )
    parser.add_argument(
        "--show-source-count",
        action="store_true",
        help="Show number of raw IPv4 entries returned by RIPEstat"
    )
    return parser.parse_args()


# ── нормализация ────────────────────────────────────────────────────────────

def normalize_country_code(country: str) -> str:
    cc = country.strip().upper()
    if len(cc) != 2 or not cc.isalpha():
        raise ValueError("Country code must be a 2-letter ISO code, e.g. RU, DE, US")
    return cc


def normalize_asn(asn: str) -> str:
    """Привести ASN к числовому виду (без префикса AS)."""
    s = str(asn).strip().upper().lstrip("AS")
    if not s.isdigit():
        raise ValueError(f"Invalid AS number: {asn!r}")
    return s


def parse_asn_list(raw: str) -> list:
    """Разобрать строку вида '12345,AS20485, 3216' в список числовых строк."""
    parts = [p.strip() for p in raw.split(",") if p.strip()]
    if not parts:
        raise ValueError("--asn-list is empty")
    return [normalize_asn(p) for p in parts]


# ── запросы к RIPEstat ──────────────────────────────────────────────────────

def _http_get(url: str, timeout: int) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": "cidr-aggregator/2.0"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        status = getattr(resp, "status", 200)
        if status != 200:
            raise RuntimeError(f"HTTP error: {status}")
        body = resp.read().decode("utf-8")
    try:
        payload = json.loads(body)
    except json.JSONDecodeError as e:
        raise RuntimeError(f"Invalid JSON from API: {e}") from e
    if payload.get("status") not in (None, "ok"):
        raise RuntimeError(f"API returned non-ok status: {payload.get('status')}")
    return payload


def fetch_country_ipv4_entries(country: str, timeout: int):
    """Загрузить IPv4-префиксы для страны через country-resource-list."""
    params = {"resource": country, "v4_format": "prefix"}
    url = f"{COUNTRY_API_URL}?{urllib.parse.urlencode(params)}"
    payload = _http_get(url, timeout)
    data = payload.get("data", {})
    entries = data.get("resources", {}).get("ipv4", [])
    if not isinstance(entries, list):
        raise RuntimeError("Unexpected API format: data.resources.ipv4 is not a list")
    return entries, url


def fetch_asn_ipv4_entries(asn: str, timeout: int):
    """Загрузить IPv4-префиксы для одного ASN через announced-prefixes."""
    params = {"resource": f"AS{asn}"}
    url = f"{ASN_API_URL}?{urllib.parse.urlencode(params)}"
    payload = _http_get(url, timeout)
    data = payload.get("data", {})
    prefixes_raw = data.get("prefixes", [])
    if not isinstance(prefixes_raw, list):
        raise RuntimeError(f"Unexpected API format for AS{asn}: data.prefixes is not a list")
    # Каждый элемент: { "prefix": "1.2.3.0/24", "timelines": [...] }
    # Берём только IPv4 (без ':')
    entries = [
        item["prefix"]
        for item in prefixes_raw
        if isinstance(item, dict) and "prefix" in item and ":" not in item["prefix"]
    ]
    return entries, url


def fetch_asn_list_ipv4_entries(asn_list: list, timeout: int):
    """Загрузить и объединить IPv4-префиксы для нескольких ASN."""
    all_entries = []
    urls = []
    for asn in asn_list:
        entries, url = fetch_asn_ipv4_entries(asn, timeout)
        all_entries.extend(entries)
        urls.append(url)
        if not entries:
            print(f"  Warning: AS{asn} returned no IPv4 prefixes", file=sys.stderr)
    return all_entries, urls


# ── разбор префиксов ────────────────────────────────────────────────────────

def parse_range(line: str):
    left, right = line.split("-", 1)
    start_ip = ipaddress.ip_address(left.strip())
    end_ip   = ipaddress.ip_address(right.strip())
    if start_ip.version != end_ip.version:
        raise ValueError("Range start and end IP versions do not match")
    if int(start_ip) > int(end_ip):
        raise ValueError("Range start IP is greater than end IP")
    return list(ipaddress.summarize_address_range(start_ip, end_ip))


def parse_entry(entry: str, strict: bool):
    entry = entry.strip()
    if not entry:
        return []
    if "-" in entry:
        return parse_range(entry)
    return [ipaddress.ip_network(entry, strict=strict)]


def parse_entries(entries, strict: bool):
    networks = []
    invalid_entries = []
    cidr_entries = 0
    range_entries = 0
    expanded_from_ranges = 0

    for idx, raw in enumerate(entries, start=1):
        try:
            parsed = parse_entry(raw, strict=strict)
            networks.extend(parsed)
            if "-" in raw:
                range_entries += 1
                expanded_from_ranges += len(parsed)
            else:
                cidr_entries += 1
        except ValueError as e:
            invalid_entries.append((idx, raw, str(e)))

    stats = {
        "cidr_entries": cidr_entries,
        "range_entries": range_entries,
        "expanded_from_ranges": expanded_from_ranges,
        "invalid_entries": invalid_entries,
    }
    return networks, stats


# ── агрегация ────────────────────────────────────────────────────────────────

def deduplicate_networks(networks):
    unique = sorted(
        set(networks),
        key=lambda n: (n.version, int(n.network_address), n.prefixlen)
    )
    duplicates_removed = len(networks) - len(unique)
    return unique, duplicates_removed


def aggregate_networks(networks):
    ipv4 = [n for n in networks if n.version == 4]
    ipv6 = [n for n in networks if n.version == 6]

    agg_v4 = list(ipaddress.collapse_addresses(
        sorted(ipv4, key=lambda n: (int(n.network_address), n.prefixlen))
    ))
    agg_v6 = list(ipaddress.collapse_addresses(
        sorted(ipv6, key=lambda n: (int(n.network_address), n.prefixlen))
    ))

    result = sorted(
        agg_v4 + agg_v6,
        key=lambda n: (n.version, int(n.network_address), n.prefixlen)
    )
    return result, len(agg_v4), len(agg_v6)


# ── вывод ────────────────────────────────────────────────────────────────────

def write_output(networks, output_path=None):
    lines = [str(n) for n in networks]
    if output_path:
        with open(output_path, "w", encoding="utf-8") as f:
            f.write("\n".join(lines))
            if lines:
                f.write("\n")
    else:
        for line in lines:
            print(line)


def print_stats(source_label, source_urls, source_count, parse_stats,
                parsed_count, dedup_count, final_count):
    reduced = dedup_count - final_count
    reduction_pct = (reduced / dedup_count * 100.0) if dedup_count else 0.0

    print("\n=== Statistics ===", file=sys.stderr)
    print(f"Source                      : {source_label}", file=sys.stderr)
    if isinstance(source_urls, list):
        for u in source_urls:
            print(f"  URL                       : {u}", file=sys.stderr)
    else:
        print(f"Source URL                  : {source_urls}", file=sys.stderr)
    print(f"Raw entries from API        : {source_count}", file=sys.stderr)
    print(f"CIDR entries parsed         : {parse_stats['cidr_entries']}", file=sys.stderr)
    print(f"Range entries parsed        : {parse_stats['range_entries']}", file=sys.stderr)
    print(f"CIDRs produced from ranges  : {parse_stats['expanded_from_ranges']}", file=sys.stderr)
    print(f"Valid prefixes after parsing: {parsed_count}", file=sys.stderr)
    print(f"Invalid entries             : {len(parse_stats['invalid_entries'])}", file=sys.stderr)
    print(f"Prefixes after dedup        : {dedup_count}", file=sys.stderr)
    print(f"Aggregated prefixes         : {final_count}", file=sys.stderr)
    print(f"Reduction after aggregation : {reduced} ({reduction_pct:.2f}%)", file=sys.stderr)

    if parse_stats["invalid_entries"]:
        print("\nInvalid entries:", file=sys.stderr)
        for idx, entry, err in parse_stats["invalid_entries"]:
            print(f"  entry {idx}: {entry!r} -> {err}", file=sys.stderr)


# ── точка входа ──────────────────────────────────────────────────────────────

def main():
    args = parse_args()

    try:
        # ── выбрать источник ─────────────────────────────────────────────────
        if args.country:
            country = normalize_country_code(args.country)
            raw_entries, source_url = fetch_country_ipv4_entries(country, timeout=args.timeout)
            source_label = f"Country {country}"
            source_urls  = source_url
            if not raw_entries:
                raise RuntimeError(f"No IPv4 entries returned for country {country}")

        elif args.asn:
            asn = normalize_asn(args.asn)
            raw_entries, source_url = fetch_asn_ipv4_entries(asn, timeout=args.timeout)
            source_label = f"AS{asn}"
            source_urls  = [source_url]
            if not raw_entries:
                raise RuntimeError(f"No IPv4 prefixes announced by AS{asn}")

        else:  # --asn-list
            asn_list = parse_asn_list(args.asn_list)
            raw_entries, source_urls = fetch_asn_list_ipv4_entries(asn_list, timeout=args.timeout)
            source_label = f"ASN list: {', '.join('AS'+a for a in asn_list)}"
            if not raw_entries:
                raise RuntimeError(f"No IPv4 prefixes returned for ASN list: {args.asn_list}")

        # ── обработка ────────────────────────────────────────────────────────
        raw_networks, parse_stats   = parse_entries(raw_entries, strict=args.strict)
        deduped_networks, dup_count = deduplicate_networks(raw_networks)
        aggregated_networks, _, _   = aggregate_networks(deduped_networks)

        if not args.stats_only:
            write_output(aggregated_networks, args.output)

        if not args.quiet:
            print_stats(
                source_label=source_label,
                source_urls=source_urls,
                source_count=len(raw_entries),
                parse_stats=parse_stats,
                parsed_count=len(raw_networks),
                dedup_count=len(deduped_networks),
                final_count=len(aggregated_networks),
            )
            if args.show_source_count:
                print(f"Duplicates removed          : {dup_count}", file=sys.stderr)

    except urllib.error.HTTPError as e:
        print(f"HTTP error while fetching data: {e.code} {e.reason}", file=sys.stderr)
        sys.exit(1)
    except urllib.error.URLError as e:
        print(f"Network error while fetching data: {e}", file=sys.stderr)
        sys.exit(1)
    except ValueError as e:
        print(f"Input error: {e}", file=sys.stderr)
        sys.exit(2)
    except RuntimeError as e:
        print(f"Runtime error: {e}", file=sys.stderr)
        sys.exit(3)
    except KeyboardInterrupt:
        print("\nInterrupted.", file=sys.stderr)
        sys.exit(130)


if __name__ == "__main__":
    main()
