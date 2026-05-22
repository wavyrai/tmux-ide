import type { AvailableCommand } from "../types";

export interface CommandSearchResult {
  command: AvailableCommand;
  score: number;
  matched: number[];
}

interface CandidateMatch {
  score: number;
  matched: number[];
}

const DEFAULT_LIMIT = 12;

function searchableName(command: AvailableCommand): string {
  return command.name.replace(/^\/+/, "");
}

function indexOffset(command: AvailableCommand): number {
  return command.name.length - searchableName(command).length;
}

function range(start: number, length: number): number[] {
  return Array.from({ length }, (_, index) => start + index);
}

function matchInitials(name: string, query: string, offset: number): CandidateMatch | null {
  const matched: number[] = [];
  let queryIndex = 0;

  for (let index = 0; index < name.length && queryIndex < query.length; index += 1) {
    const previous = index === 0 ? "" : (name[index - 1] ?? "");
    const isBoundary = index === 0 || /[\s/_-]/.test(previous);
    if (isBoundary && name[index] === query[queryIndex]) {
      matched.push(index + offset);
      queryIndex += 1;
    }
  }

  if (queryIndex !== query.length) return null;
  return { score: 675 - name.length, matched };
}

function matchSubsequence(name: string, query: string, offset: number): CandidateMatch | null {
  const matched: number[] = [];
  let queryIndex = 0;
  let gapPenalty = 0;
  let previousMatch = -1;

  for (let index = 0; index < name.length && queryIndex < query.length; index += 1) {
    if (name[index] !== query[queryIndex]) continue;
    matched.push(index + offset);
    if (previousMatch >= 0) gapPenalty += index - previousMatch - 1;
    previousMatch = index;
    queryIndex += 1;
  }

  if (queryIndex !== query.length) return null;
  return { score: 500 - gapPenalty - name.length, matched };
}

function scoreCommand(command: AvailableCommand, normalizedQuery: string): CandidateMatch | null {
  const name = searchableName(command).toLowerCase();
  const offset = indexOffset(command);

  if (name === normalizedQuery) {
    return { score: 1_000 - name.length, matched: range(offset, normalizedQuery.length) };
  }

  if (name.startsWith(normalizedQuery)) {
    return { score: 900 - name.length, matched: range(offset, normalizedQuery.length) };
  }

  const substringIndex = name.indexOf(normalizedQuery);
  if (substringIndex >= 0) {
    return {
      score: 750 - substringIndex - name.length,
      matched: range(offset + substringIndex, normalizedQuery.length),
    };
  }

  return (
    matchInitials(name, normalizedQuery, offset) ?? matchSubsequence(name, normalizedQuery, offset)
  );
}

export function searchSlashCommands(
  commands: ReadonlyArray<AvailableCommand>,
  query: string,
  limit = DEFAULT_LIMIT,
): CommandSearchResult[] {
  const boundedLimit = Math.max(0, limit);
  if (boundedLimit === 0) return [];

  const normalizedQuery = query.trim().replace(/^\/+/, "").toLowerCase();
  if (!normalizedQuery) {
    return [...commands]
      .sort((left, right) => {
        const lengthDelta = searchableName(left).length - searchableName(right).length;
        return lengthDelta === 0 ? left.name.localeCompare(right.name) : lengthDelta;
      })
      .slice(0, boundedLimit)
      .map((command) => ({
        command,
        score: -searchableName(command).length,
        matched: [],
      }));
  }

  const results: CommandSearchResult[] = [];
  for (const command of commands) {
    const match = scoreCommand(command, normalizedQuery);
    if (!match) continue;
    results.push({ command, score: match.score, matched: match.matched });
  }

  return results
    .sort((left, right) => {
      const scoreDelta = right.score - left.score;
      return scoreDelta === 0 ? left.command.name.localeCompare(right.command.name) : scoreDelta;
    })
    .slice(0, boundedLimit);
}
