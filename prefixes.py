#!/usr/bin/env python3

import argparse
import ipaddress
import json
import sys
import urllib.parse
import urllib.request


API_URL = "https://stat.ripe.net/data/country-resource-list/data.json"


def parse_args():
    parser = argparse.ArgumentParser(
        description="Fetch IPv4 prefixes for a country from RIPEstat and aggregate them."
    )
    parser.add_argument(
        "-c", "--country",
        default="RU",
        help="2-letter ISO country code (default: RU)"
    )
    parser.add_argument(
        "-o", "--output",
        help="Write aggregated prefixes to output file (default: stdout)"
    )
    parser.add_argument(
        "--timeout",
        type=int,
        default=30,
        help="HTTP timeout in seconds (default: 30)"
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


def normalize_country_code(country: str) -> str:
    cc = country.strip().upper()
    if len(cc) != 2 or not cc.isalpha():
        raise ValueError("Country code must be a 2-letter ISO code, e.g. RU, DE, US")
    return cc


def fetch_country_ipv4_entries(country: str, timeout: int):
    params = {
        "resource": country,
        "v4_format": "prefix",  # ask RIPEstat to return IPv4 as prefixes
    }
    url = f"{API_URL}?{urllib.parse.urlencode(params)}"

    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": "cidr-aggregator/1.0"
        }
    )

    with urllib.request.urlopen(req, timeout=timeout) as resp:
        status = getattr(resp, "status", 200)
        if status != 200:
            raise RuntimeError(f"HTTP error: {status}")

        body = resp.read().decode("utf-8")

    try:
        payload = json.loads(body)
    except json.JSONDecodeError as e:
        raise RuntimeError(f"Invalid JSON received from API: {e}") from e

    if payload.get("status") not in (None, "ok"):
        raise RuntimeError(f"API returned non-ok status: {payload.get('status')}")

    data = payload.get("data", {})
    resources = data.get("resources", {})
    ipv4_entries = resources.get("ipv4", [])

    if not isinstance(ipv4_entries, list):
        raise RuntimeError("Unexpected API format: data.resources.ipv4 is not a list")

    return ipv4_entries, url


def parse_range(line: str):
    left, right = line.split("-", 1)
    start_ip = ipaddress.ip_address(left.strip())
    end_ip = ipaddress.ip_address(right.strip())

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


def print_stats(country, source_url, source_count, parse_stats, parsed_count, dedup_count, final_count):
    reduced = dedup_count - final_count
    reduction_pct = (reduced / dedup_count * 100.0) if dedup_count else 0.0

    print("\n=== Statistics ===", file=sys.stderr)
    print(f"Country code                : {country}", file=sys.stderr)
    print(f"Source URL                  : {source_url}", file=sys.stderr)
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


def main():
    args = parse_args()

    try:
        country = normalize_country_code(args.country)

        raw_entries, source_url = fetch_country_ipv4_entries(country, timeout=args.timeout)
        if not raw_entries:
            raise RuntimeError(f"No IPv4 entries returned for country {country}")

        raw_networks, parse_stats = parse_entries(raw_entries, strict=args.strict)
        deduped_networks, duplicates_removed = deduplicate_networks(raw_networks)
        aggregated_networks, _, _ = aggregate_networks(deduped_networks)

        if not args.stats_only:
            write_output(aggregated_networks, args.output)

        if not args.quiet:
            print_stats(
                country=country,
                source_url=source_url,
                source_count=len(raw_entries),
                parse_stats=parse_stats,
                parsed_count=len(raw_networks),
                dedup_count=len(deduped_networks),
                final_count=len(aggregated_networks),
            )
            if args.show_source_count:
                print(f"Duplicates removed          : {duplicates_removed}", file=sys.stderr)

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
