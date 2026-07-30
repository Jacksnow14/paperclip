export function firstNonEmptyLine(text: string): string {
    return (
        text
            .split(/\r?\n/)
            .map((line) => line.trim())
            .find(Boolean) ?? ""
    );
}

// Startup banners (e.g. terminal-capability warnings) can appear before or
// after the line that actually explains a failure. Picking "the first" or
// "the last" line of stderr is a coin flip that happened to land on a
// cosmetic 256-color warning in production (AUR-4038) while the fatal
// IneligibleTierError sat one line away, discarded. Skip known noise
// prefixes and return the first line that isn't one, regardless of position.
const STDERR_NOISE_LINE_PATTERN = /^(warning|warn|notice|info|deprecat(ed|ion))\b\W?/i;
// Terminal warnings wrap across lines (e.g. "Warning: 256-color support not
// detected. Using a terminal with at least 256-color\nsupport is recommended
// for..."). The continuation line doesn't start with a noise prefix on its
// own, so without this it gets picked as "the first non-noise line" instead
// of the real error one line further down. A wrapped continuation of prose
// starts lowercase (it's mid-sentence); a new log statement starts with a
// capital letter or a symbol. Only lowercase-starting lines inherit the
// noise verdict of the line before them.
const CONTINUATION_LINE_PATTERN = /^[a-z]/;

export function selectFatalStderrLine(text: string): string {
    const lines = text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
    if (lines.length === 0) return "";
    let previousWasNoise = false;
    for (const line of lines) {
        const isNoise =
            STDERR_NOISE_LINE_PATTERN.test(line) || (previousWasNoise && CONTINUATION_LINE_PATTERN.test(line));
        if (!isNoise) return line;
        previousWasNoise = true;
    }
    return lines[0];
}
