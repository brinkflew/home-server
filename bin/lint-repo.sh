#!/usr/bin/env bash
# ==============================================================================
# The checks this repository can run on itself
# ------------------------------------------------------------------------------
# RUNS ANYWHERE, on a checkout. There is no application code here - no build, no
# test suite - so this is not a test runner. It asserts the few conventions that
# are otherwise enforced by nobody and drift silently.
#
# 1. EVERY TRACKED TEXT FILE IS ASCII. Typographic characters - em dashes, curly
#    quotes, box drawing, arrows - arrive by copy-paste and from anything that
#    generates prose, and they are invisible in review. 402 of them had
#    accumulated by 2026-08-14. They are worse than ugly in the shell scripts,
#    where they end up in a printf that a terminal may not render.
#
# 2. EVERY SCRIPT IN bin/ IS EXECUTABLE. A quadlet ExecStartPre= pointing at a
#    non-executable file fails at container start, which is a long way from the
#    commit that caused it.
#
# 3. THE SHELL SCRIPTS PASS SHELLCHECK, when shellcheck is installed. Skipped
#    rather than failed when it is not, so this stays runnable on the server.
#
# Usage:  bin/lint-repo.sh
# ==============================================================================

set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1

fails=0
say()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
ok()   { printf '  \033[32mPASS\033[0m  %s\n' "$*"; }
bad()  { printf '  \033[31mFAIL\033[0m  %s\n' "$*"; fails=$((fails + 1)); }
skip() { printf '  \033[2mSKIP\033[0m  %s\n' "$*"; }

# ------------------------------------------------------------------------------
say "ASCII"
# ------------------------------------------------------------------------------
# -I skips binary files, which is what stops this tripping over a future image.
# The pattern is any byte above 0x7F; grep -P is what makes that expressible.
offenders=$(git ls-files -z | xargs -0 grep -IPln '[^\x00-\x7F]' 2>/dev/null)
if [ -z "$offenders" ]; then
	ok "every tracked text file is ASCII"
else
	while IFS= read -r f; do
		n=$(grep -IPc '[^\x00-\x7F]' "$f" 2>/dev/null)
		bad "$f has non-ASCII on $n line(s)"
	done <<<"$offenders"
	printf '\n  The offending lines:\n'
	git ls-files -z | xargs -0 grep -IPn '[^\x00-\x7F]' 2>/dev/null | head -20 | sed 's/^/    /'
fi

# ------------------------------------------------------------------------------
say "Executable bits"
# ------------------------------------------------------------------------------
noexec=""
while IFS= read -r f; do
	[ -x "$f" ] || noexec="$noexec $f"
done < <(git ls-files 'bin/*.sh' 'bin/*.py' 'apps/*/scripts/*' 'host/greenboot/*.sh')
if [ -z "$noexec" ]; then
	ok "every script is executable"
else
	# `git update-index --chmod=+x` rather than chmod: the mode has to be in the
	# index, or it is right locally and wrong for everyone who clones.
	bad "not executable:$noexec"
	printf '    fix with: git update-index --chmod=+x <file>\n'
fi

# ------------------------------------------------------------------------------
say "Secrets"
# ------------------------------------------------------------------------------
# THE RECIPIENT LIST DRIFTS SILENTLY AND NOTHING NOTICED. .sops.yaml warns in its
# own header that adding a recipient does NOT re-encrypt existing files - you
# have to run `sops updatekeys secrets/env.sops.env` yourself - so the rules file
# and the encrypted file can disagree indefinitely while every commit looks fine.
# Two ways that hurts, and neither announces itself: a key added to .sops.yaml
# but never applied cannot decrypt anything, discovered at the moment a machine
# is being rebuilt; and a key REMOVED from .sops.yaml but still on the file is a
# revocation that did not happen.
#
# TEXT ONLY, DELIBERATELY. This compares the age recipients named in the two
# files and never decrypts, so it needs no private key and runs anywhere - which
# is what lets it live in the linter rather than only on a machine that holds a
# key. Whether the server can actually USE its key is a different question and a
# different check: secrets.decryptable in bin/verify-host.sh.
if [ ! -f .sops.yaml ] || [ ! -f secrets/env.sops.env ]; then
	skip "no .sops.yaml or secrets/env.sops.env"
else
	want=$(grep -oE 'age1[a-z0-9]+' .sops.yaml | sort -u)
	have=$(grep -oE 'recipient=age1[a-z0-9]+' secrets/env.sops.env \
		| sed 's/^recipient=//' | sort -u)
	if [ -z "$want" ]; then
		bad ".sops.yaml names no age recipients"
	elif [ "$want" = "$have" ]; then
		ok "secrets/env.sops.env is encrypted for all $(printf '%s\n' "$want" | wc -l | tr -d ' ') recipients in .sops.yaml"
	else
		missing=$(comm -23 <(printf '%s\n' "$want") <(printf '%s\n' "$have"))
		extra=$(comm -13 <(printf '%s\n' "$want") <(printf '%s\n' "$have"))
		# tr rather than an unquoted expansion. The keys belong on one line,
		# and letting the shell word-split them is not how to say so - SC2086
		# is right about that. (A comment line may not BEGIN with the linter's
		# own name either: that parses as a directive and fails with SC1072.)
		[ -z "$missing" ] || bad "in .sops.yaml but NOT on the encrypted file: $(printf '%s' "$missing" | tr '\n' ' ')- run: sops updatekeys secrets/env.sops.env"
		[ -z "$extra" ] || bad "on the encrypted file but NOT in .sops.yaml: $(printf '%s' "$extra" | tr '\n' ' ')- a revoked key still decrypts this; run: sops updatekeys secrets/env.sops.env"
	fi
fi

# ------------------------------------------------------------------------------
say "ShellCheck"
# ------------------------------------------------------------------------------
if command -v shellcheck >/dev/null 2>&1; then
	out=$(git ls-files 'bin/*.sh' 'apps/*/scripts/*.sh' 'host/greenboot/*.sh' | xargs -r shellcheck -x 2>&1)
	if [ -z "$out" ]; then
		ok "clean"
	else
		bad "shellcheck findings"
		echo "$out" | head -40 | sed 's/^/    /'
	fi
else
	skip "shellcheck is not installed"
fi

# ------------------------------------------------------------------------------
say "Check ids"
# ------------------------------------------------------------------------------
# bin/verify-host.sh writes status.json, in which every finding is keyed by a
# hand-written dotted id.
#
# WHAT IS *NOT* CHECKED HERE, and why: id uniqueness. An id legitimately appears
# several times in the source - once per branch of the same check, which is the
# design, since an id that speaks only on failure is indistinguishable from a
# check that did not run. The real invariant is "at most once per RUN", which is
# a runtime property; verify-host.sh asserts it itself at emit time. A static
# uniq -d here flags every correctly-written check, which is worse than nothing.
#
# What IS checkable statically is the shape. A malformed id means a message was
# passed in the id position - the whole finding then keys on a sentence, which
# is exactly what the id exists to avoid.
vh=bin/verify-host.sh
if [ -f "$vh" ]; then
	# Every literal argument in the id position, however spelled.
	malformed=$(grep -oE '^[[:space:]]*(ok|bad|warn|note) [^"$][^ ]*' "$vh" \
		| awk '{print $2}' | grep -vE '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$' || true)
	n=$(grep -coE '\b(ok|bad|warn|note) ([a-z][a-z0-9_]*\.[a-z][a-z0-9_]*|"\$)' "$vh" || true)
	if [ -n "$malformed" ]; then
		bad "malformed check id(s) in $vh: $(printf '%s' "$malformed" | tr '\n' ' ')"
	else
		ok "$n check ids, all well-formed"
	fi
else
	skip "no $vh"
fi

# ------------------------------------------------------------------------------
say "Topology"
# ------------------------------------------------------------------------------
# apps/dashboard/src/topology.ts is a SECOND COPY of the Network=, Pod= and
# PublishPort= lines in stacks/. CLAUDE.md has a name for that shape - when it
# rejects split-horizon DNS it calls a hand-maintained duplicate of the
# Caddyfile's site blocks "the most driftable shape this repository has a name
# for" - and the objection is correct.
#
# The duplicate exists because no container may run `podman network inspect`:
# the podman socket is SELinux-denied from container_t, which is the same
# constraint that makes the whole dashboard read-only. Discovering the topology
# at run time is not available, and these files ARE the authority anyway.
#
# So it is allowed to exist only on condition that it cannot quietly become
# fiction. This leg parses both and fails on any difference. A drawing of the
# network that is wrong is worse than no drawing at all, because it is used to
# reason about what can reach what.
topo=apps/dashboard/src/topology.ts
if [ -f "$topo" ] && command -v python3 >/dev/null 2>&1; then
	drift=$(python3 - "$topo" <<-'PY'
		import re, sys, pathlib

		topo = pathlib.Path(sys.argv[1]).read_text()

		# --- what stacks/ actually declares ---------------------------------
		declared = {}
		pods = {}
		published = set()
		for path in sorted(pathlib.Path("stacks").rglob("*")):
		    if path.suffix not in (".container", ".pod"):
		        continue
		    text = path.read_text()
		    name = re.search(r"^\s*(?:ContainerName|PodName)=(.+)$", text, re.M)
		    if not name:
		        continue
		    name = name.group(1).strip()
		    declared[name] = {
		        m.group(1).strip().removesuffix(".network")
		        for m in re.finditer(r"^\s*Network=(.+)$", text, re.M)
		    }
		    pod = re.search(r"^\s*Pod=(.+)$", text, re.M)
		    if pod:
		        pods[name] = pod.group(1).strip().removesuffix(".pod")
		    for m in re.finditer(r"^\s*PublishPort=(.+)$", text, re.M):
		        # Keep only the container-side port: the host side is a ${VAR}
		        # and the bind address is another, neither of which this file
		        # can resolve. What matters is that a publish EXISTS.
		        published.add((name, m.group(1).strip().rsplit(":", 1)[-1]))

		networks = {
		    p.stem for p in pathlib.Path("stacks").rglob("*.network")
		}

		# --- what topology.ts claims ---------------------------------------
		ts_networks = set(re.findall(r'id:\s*"([^"]+)"', topo))

		ts_nodes = {}
		ts_pods = {}
		ts_published = set()
		for block in re.finditer(
		    r'name:\s*"([^"]+)"[^}]*?networks:\s*\[([^\]]*)\]([^}]*)', topo, re.S
		):
		    node = block.group(1)
		    ts_nodes[node] = set(re.findall(r'"([^"]+)"', block.group(2)))
		    tail = block.group(3)
		    pod = re.search(r'pod:\s*"([^"]+)"', tail)
		    if pod:
		        ts_pods[node] = pod.group(1)
		    pub = re.search(r"publishes:\s*\[([^\]]*)\]", tail, re.S)
		    if pub:
		        for mapping in re.findall(r'"([^"]+)"', pub.group(1)):
		            ts_published.add((node, mapping.split("->")[-1].strip()))

		problems = []

		for missing in sorted(networks - ts_networks):
		    problems.append(f"network {missing} is in stacks/ and not in topology.ts")
		for extra in sorted(ts_networks - networks):
		    problems.append(f"network {extra} is in topology.ts and not in stacks/")

		for missing in sorted(set(declared) - set(ts_nodes)):
		    problems.append(f"container {missing} is in stacks/ and not in topology.ts")
		for extra in sorted(set(ts_nodes) - set(declared)):
		    problems.append(f"container {extra} is in topology.ts and not in stacks/")

		for node in sorted(set(declared) & set(ts_nodes)):
		    if declared[node] != ts_nodes[node]:
		        want = " ".join(sorted(declared[node])) or "(none)"
		        got = " ".join(sorted(ts_nodes[node])) or "(none)"
		        problems.append(f"{node} networks: stacks/ says [{want}], topology.ts says [{got}]")

		if pods != ts_pods:
		    problems.append(f"pod membership: stacks/ says {pods}, topology.ts says {ts_pods}")

		if published != ts_published:
		    problems.append(
		        f"published ports: stacks/ says {sorted(published)}, "
		        f"topology.ts says {sorted(ts_published)}"
		    )

		print("\n".join(problems))
	PY
	)
	if [ -z "$drift" ]; then
		ok "topology.ts matches stacks/"
	else
		bad "topology.ts has drifted from stacks/"
		printf '%s\n' "$drift" | sed 's/^/    /'
	fi
elif [ ! -f "$topo" ]; then
	skip "no $topo"
else
	skip "python3 is not installed"
fi

# ------------------------------------------------------------------------------
say "Paths"
# ------------------------------------------------------------------------------
# apps/dashboard/src/paths.ts is the second hand-maintained duplicate here and
# the more dangerous one, because it cannot be derived in full. Half of these
# edges live in Sonarr's, Radarr's, Prowlarr's, Bazarr's and Jellyseerr's own
# databases - CLAUDE.md says it outright about the download client: "a git grep
# does not find them and a restore brings the old value back."
#
# So this leg VALIDATES rather than diffs, and the check it can make is the one
# that matters: every bridge carries Options=isolate=true, so two containers
# that share no segment have no route to each other. An edge between them is a
# drawing of a path that cannot exist - and a drawing of the network that is
# wrong is worse than none, because it is used to reason about what can reach
# what.
#
# It deliberately does NOT check which segment carries an edge, because paths.ts
# deliberately does not say: caddy and sonarr share net-arr AND net-download,
# and which one podman's DNS resolves at connect time is observable nowhere. The
# intersection is derived at render time and rendered as ambiguity.
#
# THE FLOOR IS NOT DECORATION. A regex that stops matching prints nothing and
# passes, which is indistinguishable from a clean run - the same shape as the
# ShellCheck leg that once reported "all checks passed" over 2,224 lines it had
# never read. (Note the capital: a comment opening with the lowercase name is
# read as a directive by the very tool it is describing, which fails this file's
# own ShellCheck leg. That is a small joke at nobody's expense.) So the parse
# counts what it found and refuses a file with implausibly few edges in it.
paths=apps/dashboard/src/paths.ts
topo=apps/dashboard/src/topology.ts
if [ -f "$paths" ] && [ -f "$topo" ] && command -v python3 >/dev/null 2>&1; then
	drift=$(python3 - "$paths" "$topo" <<-'PY'
		import re, sys, pathlib

		# Raise this when edges are added. It exists so that a parse which has
		# stopped matching reads as a failure rather than as a clean run.
		MIN_PATHS = 46

		paths = pathlib.Path(sys.argv[1]).read_text()
		topo = pathlib.Path(sys.argv[2]).read_text()
		problems = []

		# topology.ts is parsed again rather than shared with the leg above: that
		# one proves it matches stacks/, this one only needs the node table it
		# has just been proved to hold. Sharing state would make one failure
		# read as both.
		nodes, pods = {}, {}
		for block in re.finditer(
		    r'name:\s*"([^"]+)"[^}]*?networks:\s*\[([^\]]*)\]([^}]*)', topo, re.S
		):
		    nodes[block.group(1)] = set(re.findall(r'"([^"]+)"', block.group(2)))
		    pod = re.search(r'pod:\s*"([^"]+)"', block.group(3))
		    if pod:
		        pods[block.group(1)] = pod.group(1)
		if not nodes:
		    problems.append("topology.ts parsed to ZERO nodes - every check below would pass vacuously")

		pseudo = set(re.findall(r'^\s*(\w+): "[^"]*(?:inbound|outbound)[^"]*",\s*$', paths, re.M))
		# The list paths.ts declares rather than one this file keeps its own copy
		# of - a second copy of a security property is one that can drift out of
		# agreement with the thing it protects.
		never_to = set(re.findall(r'"([^"]+)"',
		                          (re.search(r"NEVER_A_DESTINATION = \[([^\]]*)\]",
		                                     paths, re.S) or type("m", (), {"group": lambda *_: ""})()).group(1)))
		if not never_to:
		    problems.append("paths.ts declares no NEVER_A_DESTINATION - the "
		                    "outbound-only invariant is unenforced")
		if not pseudo:
		    problems.append("paths.ts declares no PSEUDO_NODES - a terminal edge would read as a broken one")

		# Records are split on the OPENING brace, never a closing one: a `why`
		# legitimately contains "}" - "torrent:{$PORT_JOAL_WEB}" does - so any
		# non-greedy {...} parse truncates records and reports nothing.
		body = paths.split("export const PATHS", 1)
		section = body[1] if len(body) == 2 else ""
		if not section:
		    problems.append("paths.ts has no `export const PATHS` - the parse below would find nothing and say nothing")
		opens = len(re.findall(r"^\s*\{ from:", section, re.M))

		edges = []
		for chunk in re.split(r"^\s*\{(?=\s*from:)", section, flags=re.M)[1:]:
		    rec = {}
		    for key in ("from", "to", "why", "source"):
		        m = re.search(r'\b%s: "((?:[^"\\]|\\.)*)"' % key, chunk)
		        if m:
		            rec[key] = m.group(1)
		    if len(rec) == 4:
		        edges.append(rec)

		if opens != len(edges):
		    problems.append(
		        f"paths.ts: {opens} record(s) open with `from:` but only {len(edges)} "
		        "parsed with all four fields - every edge needs from, to, why and source"
		    )
		if len(edges) < MIN_PATHS:
		    problems.append(
		        f"paths.ts parsed to {len(edges)} edge(s), floor is {MIN_PATHS} - either the "
		        "file has shrunk or the parse has stopped matching, and those look identical here"
		    )

		bad_source = sorted({e["source"] for e in edges} - {"git", "runtime"})
		if bad_source:
		    problems.append("paths.ts: unknown source " + " ".join(bad_source) + " - it is a closed set")

		def reach(node):
		    """Which segments a node can actually use. A pod member declares
		    networks: [] and reaches the world through its pod's, which is the
		    entire point of the pod."""
		    if node not in nodes:
		        return None
		    return nodes[node] | nodes.get(pods.get(node, ""), set())

		terminals = crossed = ambiguous = 0
		for e in edges:
		    frm, to = e["from"], e["to"]
		    for end in (frm, to):
		        if end not in nodes and end not in pseudo:
		            problems.append(f"edge {frm} -> {to}: {end} is in neither topology.ts NODES nor PSEUDO_NODES")
		    # NOTHING HELD THE ONE INVARIANT THAT IS A SECURITY PROPERTY. conduct
		    # and the phase runners are host-side and initiate every connection
		    # they have - which is why the control plane needs no route to the
		    # host and ucore.bu needed no firewalld change. paths.ts says so in a
		    # comment and calls it exactly that; this loop then `continue`d past
		    # every pseudo-node edge before any check ran, so an inbound one
		    # would have drawn an arrow into conduct in silence.
		    #
		    # THE LIST IS DECLARED IN paths.ts AND NOT INFERRED HERE. The
		    # descriptions cannot carry it: `internet` is "outbound only" meaning
		    # it is where outbound traffic GOES, and `conduct` is "outbound only"
		    # meaning it is what STARTS the connection - the same two words, the
		    # opposite ends of an edge. A first draft read them mechanically and
		    # failed six correct edges.
		    if to in never_to:
		        problems.append(
		            f"edge {frm} -> {to}: paths.ts declares {to} may never be a `to`. "
		            f"For conduct that is not modelling - a route INTO the host is "
		            f"what five files in this repository refuse")
		    if frm in pseudo or to in pseudo:
		        terminals += 1
		        continue
		    a, b = reach(frm), reach(to)
		    if a is None or b is None:
		        continue
		    if pods.get(frm) and pods.get(frm) == pods.get(to):
		        # One namespace, not one network. Their networks lists are both
		        # empty and intersect to nothing, which is not a violation - it
		        # is the tightest coupling in the stack.
		        continue
		    shared = a & b
		    if not shared:
		        problems.append(
		            f"edge {frm} -> {to} crosses no shared segment: stacks/ puts {frm} on "
		            f"[{' '.join(sorted(a)) or '(none)'}] and {to} on [{' '.join(sorted(b)) or '(none)'}]. "
		            "Every bridge is isolate=true, so that route cannot exist"
		        )
		    else:
		        crossed += 1
		        if len(shared) > 1:
		            ambiguous += 1

		if not problems:
		    runtime = sum(1 for e in edges if e["source"] == "runtime")
		    print("OK %d edges (%d runtime-only, %d terminal), %d cross a shared segment, "
		          "%d of those share more than one" % (len(edges), runtime, terminals, crossed, ambiguous))
		else:
		    print("\n".join(problems))
	PY
	)
	case "$drift" in
	OK\ *) ok "paths.ts: ${drift#OK }" ;;
	*)
		bad "paths.ts does not describe this topology"
		printf '%s\n' "$drift" | sed 's/^/    /'
		;;
	esac
elif [ ! -f "$paths" ]; then
	skip "no $paths"
else
	skip "python3 is not installed"
fi

# ------------------------------------------------------------------------------
say "Quadlets"
# ------------------------------------------------------------------------------
# Catches syntax errors, NOT unset variables - systemd expands an unset ${VAR}
# to an empty string and logs it at info level, so those only surface at runtime.
# Overridable, because this path is packaging-dependent: it is where Fedora and
# uCore put the standalone generator, and a CI runner on another distribution
# may not agree. NOT the podman-user-generator path - see CLAUDE.md, the wrong
# one fails with "No such file or directory" and reads as unavailable rather
# than as misspelled.
QUADLET="${QUADLET:-/usr/libexec/podman/quadlet}"
if [ -x "$QUADLET" ]; then
	if qout=$(QUADLET_UNIT_DIRS="$PWD/stacks/common:$PWD/stacks/torrent:$PWD/stacks/media:$PWD/stacks/infra" \
		"$QUADLET" -dryrun -user 2>&1); then
		ok "$(git ls-files 'stacks/*' | grep -cE '\.(container|network|pod|build)$') units generate"
	else
		# SHOW THE ERROR. This said only "quadlet -dryrun failed" until
		# 2026-08-19, which is useless anywhere the generator disagrees with
		# this workstation - and that is exactly where it first fired, on a CI
		# runner whose podman is older than the host's and rejects a directive
		# that is valid here. A linter that will not say what it found sends
		# you to reproduce its own run by hand.
		bad "quadlet -dryrun failed"
		# FILTER THE CHATTER BEFORE TRUNCATING, not after. The generator logs
		# "Loading source unit file" for all 35 units and the real complaint
		# comes last, so a plain `head` shows nothing but the preamble - and
		# closing the pipe early makes both grep and printf report a broken
		# pipe, which then looks like the failure. That is what the first CI
		# run produced.
		printf '%s\n' "$qout" \
			| grep -avE '^$|Loading source unit file' \
			| tail -20 | sed 's/^/    /'
	fi
else
	skip "no quadlet generator at $QUADLET"
fi

# ------------------------------------------------------------------------------
say "Fact and metric names"
# ------------------------------------------------------------------------------
# THE TWO WRITERS SHARE ONE EXPOSITION FILE. bin/verify-host.sh records facts,
# source_status in bin/collect-metrics.py mints `home_server_<fact key>` for each
# numeric one, and that file's own m.add() names land beside them. Prometheus
# tolerates a duplicate sample whose value matches and REJECTS THE WHOLE SCRAPE
# when it does not - and these two disagree by construction, because the battery
# is hourly and the collector runs every thirty seconds. So the failure is not a
# wrong number on one panel: it is every metric on the host disappearing, waiting
# on whichever pair of samples first drifts apart.
#
# collect-metrics.py carries FACT_OWNED_ELSEWHERE for the one collision it wants,
# and the comment above it records how that was found - "by reading the exposition
# rather than by the check, which stayed green throughout". This is that check,
# and it is static because the runtime version needs the two writers to disagree
# first.
#
# THE AGENTS SECTION IS WHY IT EXISTS NOW. The battery's facts are `agents_*` and
# the collector's family is `home_server_agent_*`, singular - one letter apart, in
# two files, neither of which mentions the other's spelling at the point it
# matters.
vh=bin/verify-host.sh
cm=bin/collect-metrics.py
if [ -f "$vh" ] && [ -f "$cm" ]; then
	# EVERY home_server_ STRING LITERAL, not just the ones m.add() is handed
	# directly, and the difference is the whole check. Most names in that file are
	# built as `"home_server_agent_" + suffix` inside a loop, so a grep for the
	# m.add() call captures the PREFIX and never the name - which is how the first
	# version of this leg passed with a deliberate collision planted in front of
	# it. A literal ending in `_` is therefore treated as a prefix and shadows
	# every fact key under it; anything with a `%` is a format string in
	# source_status's own bridge, which mints from fact keys rather than beside
	# them, and is skipped.
	#
	# THE BARE `home_server_` LITERAL IS EXCLUDED, and it has to be: it is
	# source_status's own bridge, `m.add("home_server_" + key, ...)`, which mints
	# FROM fact keys rather than beside them. Left in, it is a prefix matching
	# every candidate and the leg fails on all ninety of them - which is the same
	# uselessness as passing on all of them, one direction over.
	literals=$(grep -oE '"home_server_[a-z0-9_%]*"' "$cm" | tr -d '"' \
		| grep -v '%' | grep -vx 'home_server_' | sort -u)
	minted=$(printf '%s\n' "$literals" | grep -v '_$' || true)
	prefixes=$(printf '%s\n' "$literals" | grep '_$' || true)
	# The collisions collect-metrics.py deliberately owns and already skips.
	owned=$(sed -n '/^FACT_OWNED_ELSEWHERE = (/,/^)/p' "$cm" \
		| grep -oE '"[a-z0-9_]+"' | tr -d '"' | sort -u)
	clash=""
	# Process substitution rather than a pipe: a `while read` on the right of a
	# pipe runs in a subshell, and $clash below would be assigned there and lost -
	# the loop would then report success no matter what it found.
	while read -r key; do
		printf '%s\n' "$owned" | grep -qx "$key" && continue
		# Every name source_status can mint from this key: the plain form, plus
		# the unit rewrite it applies by suffix. Kept in step with that function.
		cands="home_server_$key"
		case "$key" in
			*_mb) cands="$cands home_server_${key%_mb}_bytes" ;;
			*_s)  cands="$cands home_server_${key%_s}_seconds" ;;
			*_at) cands="$cands home_server_${key%_at}_timestamp_seconds" ;;
		esac
		for cand in $cands; do
			printf '%s\n' "$minted" | grep -qx "$cand" &&
				clash="$clash $key->$cand"
			for pre in $prefixes; do
				case "$cand" in "$pre"*) clash="$clash $key->${pre}*" ;; esac
			done
		done
	done < <(grep -oE '^[[:space:]]*fact [a-z][a-z0-9_]*' "$vh" \
		| awk '{print $2}' | sort -u)
	if [ -n "$clash" ]; then
		bad "fact key(s) shadow a metric collect-metrics.py mints:$clash
    Rename one side. A duplicate sample whose values disagree rejects the whole
    scrape, and the two writers run on different schedules by design."
	else
		ok "$(printf '%s\n' "$minted" | grep -c .) collector metric names and $(printf '%s\n' "$prefixes" | grep -c .) name prefix(es), none shadowed by a fact key"
	fi
else
	skip "no $vh or $cm"
fi

# ------------------------------------------------------------------------------
say "Round derivation"
# ------------------------------------------------------------------------------
# THE ONE PIECE OF LOGIC IN THIS REPOSITORY THAT NOTHING ELSE COULD SEE WRONG.
#
# `_fleet_derive_rounds` reconstructs a round from the run log, and three readers
# in the browser take its answer as fact: PhaseSteps fills a node, phaseLabel
# counts the numerator, and _fleet_eta prices what is left. The dashboard's smoke
# test drives all three - against fixtures/fleet.ts, which STATES the contract
# correctly and is written by hand, so it can only ever agree with itself.
#
# It went wrong for as long as it existed and nothing anywhere could tell: the
# board blinked the `ship` node through plan, dev, verify and review, because
# `chain.phase` is the flow's WORK argument rather than the phase in flight, and
# because a run row opened at the START of a phase was counted as one behind it.
# Every key was present, every type was right, and the fixture said the opposite.
#
# So this is the collector's only unit test, and it is here rather than in
# fixtures/smoke.mjs because that harness is node and this function is python.
# It builds a round in memory and asserts what the fixture asserts.
cm=bin/collect-metrics.py
if [ -f "$cm" ] && command -v python3 >/dev/null 2>&1; then
	drift=$(python3 - "$cm" <<-'PY'
		import importlib.util
		import json
		import sqlite3
		import sys

		spec = importlib.util.spec_from_file_location("collect_metrics", sys.argv[1])
		cm = importlib.util.module_from_spec(spec)
		spec.loader.exec_module(cm)

		conn = sqlite3.connect(":memory:")
		conn.row_factory = sqlite3.Row
		conn.execute("""
		    CREATE TABLE run (
		        id INTEGER PRIMARY KEY, project TEXT, phase TEXT,
		        worktree_id TEXT, started_at TEXT, ended_at TEXT, result TEXT,
		        exit_code INTEGER, cost_usd REAL, tokens_in INTEGER,
		        tokens_out INTEGER, task TEXT, odoo_task INTEGER, error TEXT,
		        branch TEXT, log TEXT)
		""")
		# THE ROUND'S ATTEMPT NUMBER COMES OFF THIS TABLE, not off counting the
		# groups - see _fleet_number_rounds. conduct puts chain_open's own count
		# in the plan step's payload, which is the only copy a later round does
		# not overwrite.
		conn.execute("""
		    CREATE TABLE dispatch (
		        flow_job_id TEXT, module_id TEXT, project TEXT, phase TEXT,
		        worktree_id TEXT, started_at TEXT, payload TEXT)
		""")

		def run(phase, worktree, result, started, ended=None):
		    conn.execute(
		        "INSERT INTO run (project, phase, worktree_id, started_at,"
		        " ended_at, result, cost_usd, tokens_in, tokens_out, task,"
		        " odoo_task) VALUES ('p', ?, ?, ?, ?, ?, 0.0, 0, 0, 'do it', 7)",
		        (phase, worktree, started, ended, result))

		# One round, mid-gate: plan and dev behind it, the verification running
		# on the worktree of its own that _fleet_parent folds back.
		run("plan", "wt", "ok", "2026-01-01T00:00:00Z", "2026-01-01T00:05:00Z")
		run("dev", "wt", "ok", "2026-01-01T00:05:00Z", "2026-01-01T00:40:00Z")
		run("verify", "wt-verify", None, "2026-01-01T00:40:00Z")
		conn.commit()

		bad = []
		rounds = cm._fleet_derive_rounds(conn)
		if len(rounds) != 1:
		    bad.append("one round became %d" % len(rounds))
		else:
		    got = rounds[0]
		    if got["phase"] != "verify":
		        bad.append("the phase in flight reads %r, not 'verify'"
		                   % got["phase"])
		    if got["done"] != ["plan", "dev"]:
		        bad.append("done is %r - the phase in flight is not behind it"
		                   % (got["done"],))
		    if got["worktree_id"] != "wt":
		        bad.append("the verification's worktree did not fold back: %r"
		                   % got["worktree_id"])
		    for key in ("seen", "after", "plan_log"):
		        if key in got:
		            bad.append("`%s` is working state and must not reach the"
		                       " browser" % key)

		# The gate's elapsed time is what the ETA subtracts, and the worktree it
		# is asked for is the folded one.
		if cm._fleet_phase_started(conn, "wt", "verify") is None:
		    bad.append("a running verification is invisible to _fleet_phase_started")

		# A round whose PLAN is still running must stay on the board - the filter
		# asks whether a plan ran, which `done` can no longer answer.
		second = sqlite3.connect(":memory:")
		second.row_factory = sqlite3.Row
		conn.backup(second)
		second.execute("DELETE FROM run")
		second.execute(
		    "INSERT INTO run (project, phase, worktree_id, started_at, task,"
		    " odoo_task) VALUES ('p', 'plan', 'wt2', '2026-01-01T01:00:00Z',"
		    " NULL, 7)")
		second.commit()
		fresh = cm._fleet_derive_rounds(second)
		if len(fresh) != 1 or fresh[0]["done"] != []:
		    bad.append("a round whose plan is still running reads %r"
		               % ([(r["phase"], r["done"]) for r in fresh],))


		# THE ATTEMPT NUMBER, AND THE FOUR SHAPES THAT DECIDE IT. Counting a task's
		# rounds here is what drew "attempt 5 of 3" on the round that shipped task
		# 1264: MAX_ATTEMPTS bounds a CHAIN, and chain_open restarts at 1 whenever a
		# task is re-picked after its chain closed. None of this was assertable
		# before - the leg built one round, and one round is the shape every wrong
		# derivation gets right.
		third = sqlite3.connect(":memory:")
		third.row_factory = sqlite3.Row
		conn.backup(third)
		third.execute("DELETE FROM run")
		third.execute("DELETE FROM dispatch")

		def round_at(db, worktree, started, task, ended):
		    db.execute(
		        "INSERT INTO run (project, phase, worktree_id, started_at,"
		        " ended_at, result, cost_usd, tokens_in, tokens_out, task,"
		        " odoo_task) VALUES ('p', 'plan', ?, ?, ?, 'ok', 0.0, 0, 0,"
		        " 'do it', ?)", (worktree, started, ended, task))

		def planned(db, worktree, started, payload):
		    db.execute(
		        "INSERT INTO dispatch (flow_job_id, module_id, project, phase,"
		        " worktree_id, started_at, payload)"
		        " VALUES (?, 'conduct_plan', 'p', 'ship', ?, ?, ?)",
		        (started, worktree, started, json.dumps(payload)))

		# Two rounds of one chain, then a REPAIR - which conduct counts but which
		# runs no planning phase, so it starts no round here - then the round after
		# it, then the same task re-picked, which conduct starts again at 1.
		planned(third, "wt", "2026-02-01T00:00:00Z", {"attempt": 1})
		round_at(third, "wt", "2026-02-01T00:00:01Z", 7, "2026-02-01T00:05:00Z")
		planned(third, "wt", "2026-02-01T01:00:00Z", {"attempt": 2})
		round_at(third, "wt", "2026-02-01T01:00:01Z", 7, "2026-02-01T01:05:00Z")
		planned(third, "wt", "2026-02-01T02:00:00Z",
		        {"attempt": 3, "skipped": "the plan for this round is already"})
		planned(third, "wt", "2026-02-01T03:00:00Z", {"attempt": 4})
		round_at(third, "wt", "2026-02-01T03:00:01Z", 7, "2026-02-01T03:05:00Z")
		# The re-pick. Same task, same lane, and conduct's counter back at 1.
		planned(third, "wt", "2026-02-02T00:00:00Z", {"attempt": 1})
		round_at(third, "wt", "2026-02-02T00:00:01Z", 7, "2026-02-02T00:05:00Z")
		# A repair on the re-picked chain, and then a plan run conduct never
		# dispatched - a hand `conduct run --phase plan`. The worktree is
		# reused, so the danger is answering with the repair's number rather
		# than None, and this is the pair that tells the `skipped` guard from
		# merely taking the latest row: without it, the hand run reads 2.
		planned(third, "wt", "2026-02-02T12:00:00Z",
		        {"attempt": 2, "skipped": "the plan for this round is already"})
		round_at(third, "wt", "2026-02-03T00:00:00Z", 7, "2026-02-03T00:05:00Z")
		third.commit()

		numbered = [(r["started_at"], r["attempts"])
		            for r in cm._fleet_derive_rounds(third)]
		numbered.reverse()
		want = [("2026-02-01T00:00:01Z", 1), ("2026-02-01T01:00:01Z", 2),
		        ("2026-02-01T03:00:01Z", 4), ("2026-02-02T00:00:01Z", 1),
		        ("2026-02-03T00:00:00Z", None)]
		if numbered != want:
		    bad.append("the attempt numbers read %r, not %r" % (numbered, want))


		# THE EXACT JOIN WINS OVER THE TIMESTAMP ONE, and the three shapes that
		# answer None. conduct puts the plan phase's log path in the same payload as
		# the attempt, and `run.log` is the same string - so where both exist the
		# round and its dispatch are matched by identity. The decoy here is what the
		# timestamp join would have taken: a later, non-skipped, log-less row.
		fourth = sqlite3.connect(":memory:")
		fourth.row_factory = sqlite3.Row
		conn.backup(fourth)
		fourth.execute("DELETE FROM run")
		fourth.execute("DELETE FROM dispatch")
		planned(fourth, "wt", "2026-03-01T00:00:00Z",
		        {"attempt": 4, "log": "/logs/plan-a.log"})
		planned(fourth, "wt", "2026-03-01T00:30:00Z", {"attempt": 9})
		fourth.execute(
		    "INSERT INTO run (project, phase, worktree_id, started_at, ended_at,"
		    " result, cost_usd, tokens_in, tokens_out, task, odoo_task, log)"
		    " VALUES ('p','plan','wt','2026-03-01T01:00:00Z','2026-03-01T01:05:00Z',"
		    " 'ok',0.0,0,0,'do it',7,'/logs/plan-a.log')")
		# A payload with no attempt at all - a plan phase conduct could not record a
		# number for - and one that is NULL, which is the row of a plan step still
		# running. Both answer None rather than raising or inventing.
		planned(fourth, "wt", "2026-03-02T00:00:00Z", {"log": "/logs/plan-b.log"})
		round_at(fourth, "wt", "2026-03-02T00:00:01Z", 7, "2026-03-02T00:05:00Z")
		fourth.execute(
		    "INSERT INTO dispatch (flow_job_id, module_id, project, phase,"
		    " worktree_id, started_at, payload)"
		    " VALUES ('j', 'conduct_plan', 'p', 'ship', 'wt',"
		    " '2026-03-03T00:00:00Z', NULL)")
		round_at(fourth, "wt", "2026-03-03T00:00:01Z", 7, "2026-03-03T00:05:00Z")
		# A dispatch under the VERIFICATION's own lane id. Latent today -
		# conduct dispatches every module under the round's worktree - but the
		# group id is folded by _fleet_parent, so an unfolded comparison would
		# stop matching the day that changed, with nothing saying why.
		planned(fourth, "wt-verify", "2026-03-04T00:00:00Z", {"attempt": 2})
		round_at(fourth, "wt", "2026-03-04T00:00:01Z", 7, "2026-03-04T00:05:00Z")
		fourth.commit()
		exact = [(r["started_at"], r["attempts"])
		         for r in cm._fleet_derive_rounds(fourth)]
		exact.reverse()
		want_exact = [("2026-03-01T01:00:00Z", 4), ("2026-03-02T00:00:01Z", None),
		              ("2026-03-03T00:00:01Z", None), ("2026-03-04T00:00:01Z", 2)]
		if exact != want_exact:
		    bad.append("the log join reads %r, not %r" % (exact, want_exact))

		# AND A DATABASE WITH NO `dispatch` TABLE MUST NOT RAISE. source_fleet turns
		# any sqlite error into "unreadable" and blanks every row, which is the
		# 2026-08-28 failure the optional-column guard exists to stop. This function
		# is the first thing to make the board depend on a second table.
		bare = sqlite3.connect(":memory:")
		bare.row_factory = sqlite3.Row
		fourth.backup(bare)
		bare.execute("DROP TABLE dispatch")
		bare.commit()
		try:
		    numbers = [r["attempts"] for r in cm._fleet_derive_rounds(bare)]
		    if any(n is not None for n in numbers):
		        bad.append("no dispatch table, yet the rounds claim %r" % numbers)
		except Exception as exc:  # noqa: BLE001 - any raise here blanks the board
		    bad.append("a database with no dispatch table raises %r" % (exc,))

		print("\n".join(bad))
	PY
	)
	if [ -n "$drift" ]; then
		bad "_fleet_derive_rounds does not agree with fixtures/fleet.ts - the"
		printf '        board reads phase as what is running and done as what is behind it\n'
		printf '%s\n' "$drift" | sed 's/^/    /'
	else
		ok "a round mid-gate names its phase, folds its verification and counts neither as done"
		ok "an attempt number is conduct's own count, and a re-picked task starts again at 1"
		ok "the log path outranks the timestamp, and three absences answer null rather than raise"
	fi
	# AND THE ONE SOURCE THAT MAY NEVER SUPPLY THAT PHASE, asserted by name
	# because reaching it needs source_fleet and eight tables of fixture.
	# chain.phase is the flow's `phase` ARGUMENT - written once by chain_open,
	# never updated, and "ship" for every round the ship flow has ever run. It
	# spells one of FLEET_PHASES, so reading it looked like reading a phase.
	if grep -q 'chain\["phase"\]' "$cm"; then
		bad "$cm reads chain[\"phase\"], which is the flow's own argument and"
		printf '        never the phase in flight - the run log is the only source for that\n'
	else
		ok "chain.phase, which is the flow's argument, reaches no reader"
	fi
else
	skip "no $cm, or python3 is not installed"
fi

# ------------------------------------------------------------------------------
say "Attempt ceiling"
# ------------------------------------------------------------------------------
# THE CHECK FLEET_MAX_ATTEMPTS' OWN COMMENT ASKS FOR AND NOBODY WROTE.
#
# The collector is stdlib-only and must run on a host where the agents checkout
# is absent, so conduct's MAX_ATTEMPTS is copied rather than imported - and the
# copy stayed at 2 when conduct moved to 3 on 2026-08-28. Nothing failed, no test
# noticed, and the board would have drawn "attempt 3 of 2" the first time a
# change used its third. The comment says it out loud: "A second copy of a fact
# is a thing to check when the first one moves."
#
# It is the DENOMINATOR of the number the leg above fixes, so a correct attempt
# drawn against a stale ceiling is still a wrong sentence.
conf=""
for candidate in "${AGENTS_REPO:-}" ../agents /var/agents; do
	if [ -n "$candidate" ] && [ -f "$candidate/conduct/config.py" ]; then
		conf="$candidate/conduct/config.py"
		break
	fi
done
if [ -n "$conf" ] && [ -f "$cm" ]; then
	theirs=$(sed -n 's/^MAX_ATTEMPTS *= *\([0-9][0-9]*\).*/\1/p' "$conf" | head -1)
	ours=$(sed -n 's/^FLEET_MAX_ATTEMPTS *= *\([0-9][0-9]*\).*/\1/p' "$cm" | head -1)
	if [ -z "$theirs" ] || [ -z "$ours" ]; then
		# NOT A PASS. Either name having moved is exactly the drift this exists
		# to catch, and a grep that finds nothing must not read as agreement.
		bad "could not read MAX_ATTEMPTS ($conf) or FLEET_MAX_ATTEMPTS ($cm)"
	elif [ "$theirs" != "$ours" ]; then
		bad "FLEET_MAX_ATTEMPTS is $ours and conduct's MAX_ATTEMPTS is $theirs - the"
		printf '        board would draw every attempt against the wrong ceiling\n'
	else
		ok "FLEET_MAX_ATTEMPTS $ours matches conduct MAX_ATTEMPTS $theirs"
	fi
else
	skip "the agents checkout is not beside this one (set AGENTS_REPO to point at it)"
fi

# ------------------------------------------------------------------------------
say "Custom properties"
# ------------------------------------------------------------------------------
# A DECLARATION THAT READS A PROPERTY NOTHING DEFINES DOES NOTHING, AND LOOKS
# EXACTLY LIKE ONE THAT WORKS.
#
# var(--x) with no --x anywhere is invalid at computed-value time: an inherited
# property falls back to `inherit` and an unset one to its initial value, so the
# rule silently does nothing and the element usually still looks right, because
# the value it inherits is the one somebody meant. Nothing in the toolchain says
# a word - vue-tsc does not read CSS, and there is no CSS test.
#
# THIS REPOSITORY HAS HIT IT TWICE. --ink* and --t-micro were in no stylesheet
# and are already in docs/known-state.md; --fg-1 on the network overview's
# headline was the second, and it went unseen because --fg is what it fell back
# to and --fg is what it should have said.
#
# A PROPERTY IS DECLARED IN TWO PLACES AND BOTH COUNT. `--x:` in a stylesheet,
# and "--x" set from a template - Band.vue passes --cols and the tables pass
# --rail through :style - so the reads and the writes have to be collected from
# the whole tree rather than from tokens.css, or every locally-scoped property
# in the app reads as undefined.
#
# AND COMMENTS ARE NOT CODE. The first version of this read them, and its first
# finding was --cards in a HomePage docblock explaining the bento grid that was
# DELETED - a rule describing what a file used to do, reported as a live defect.
# Block and template comments come out of both sides before either is collected:
# a property named only in a comment neither declares nor reads anything.
if [ -d apps/dashboard/src ] && command -v python3 >/dev/null 2>&1; then
	undefined=$(python3 - <<'PYEOF'
import pathlib, re, sys

root = pathlib.Path("apps/dashboard/src")
files = sorted(p for p in root.rglob("*") if p.suffix in {".vue", ".css", ".ts"})
# /* ... */ covers a CSS rule's comment and a .vue docblock alike; <!-- --> is
# the template's. Left alone: // to end of line, because a var() in one is not
# a shape this app has and eating a line that begins with a URL would be worse.
STRIP = re.compile(r"/\*.*?\*/|<!--.*?-->", re.S)
blob = {p: STRIP.sub(" ", p.read_text(encoding="utf-8")) for p in files}

# Declared: a CSS declaration, or a quoted key handed to :style / setProperty.
declared = set()
for text in blob.values():
    declared.update(re.findall(r"(--[A-Za-z0-9_-]+)\s*:", text))
    declared.update(re.findall(r"[\"'](--[A-Za-z0-9_-]+)[\"']", text))

# Read: var(--x). A fallback - var(--x, 4px) - is still a read of --x.
missing = {}
for path, text in blob.items():
    for name in re.findall(r"var\(\s*(--[A-Za-z0-9_-]+)", text):
        if name not in declared:
            missing.setdefault(name, set()).add(str(path))

for name in sorted(missing):
    print(name, " ".join(sorted(missing[name])))
PYEOF
	)
	if [ -n "$undefined" ]; then
		while read -r name where; do
			[ -n "$name" ] || continue
			bad "$name is read but declared nowhere - $where"
		done <<< "$undefined"
	else
		ok "every var(--x) under apps/dashboard/src names a property something declares"
	fi
else
	skip "no apps/dashboard/src, or python3 is not installed"
fi

echo
say "Windmill pin"
# ------------------------------------------------------------------------------
# THREE FILES AND ONE NUMBER, and a half-done bump is two binaries against one
# schema - which is a corrupted control plane rather than a failed start, so
# nothing would go red. stacks/README.md names the trap and nothing checked it;
# update.pin_lag in bin/verify-host.sh grades how far behind the pin is and
# reads ONE of the three, so this is what makes reading one of them sound.
wm_tags=$(sed -n 's/^Image=.*windmill:\(.*\)$/\1/p' \
	stacks/infra/windmill-*.container 2>/dev/null | sort -u)
wm_n=$(printf '%s\n' "$wm_tags" | grep -c .)
if [ "$wm_n" -eq 0 ]; then
	skip "no windmill image pin found"
elif [ "$wm_n" -eq 1 ]; then
	ok "all windmill units pin $wm_tags"
else
	bad "windmill units disagree on the image tag: $(printf '%s' "$wm_tags" | tr '\n' ' ') - two binaries against one schema is a corrupted control plane, not a failed start"
fi

echo
if [ "$fails" -gt 0 ]; then
	printf '\033[31m%d check(s) FAILED\033[0m\n' "$fails"
	exit 1
fi
printf '\033[32mall checks passed\033[0m\n'
