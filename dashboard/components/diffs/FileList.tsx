"use client";

interface FileEntry {
  file: string;
  additions: number;
  deletions: number;
}

interface FileListProps {
  files: FileEntry[];
  selectedFile: string | null;
  onSelectFile: (file: string | null) => void;
}

export function FileList({ files, selectedFile, onSelectFile }: FileListProps) {
  if (files.length === 0) {
    return <div className="text-[var(--dim)] px-2 py-4">No changed files</div>;
  }

  return (
    <div>
      {/* "All files" option */}
      <button
        onClick={() => onSelectFile(null)}
        className={`w-full flex items-center h-6 px-2 text-left transition-colors ${
          selectedFile === null
            ? "bg-[var(--surface-active)] text-[var(--accent)]"
            : "text-[var(--dim)] hover:bg-[var(--surface-hover)] hover:text-[var(--fg)]"
        }`}
      >
        <span className="flex-1 truncate">All files</span>
        <span className="shrink-0 text-[var(--dim)]">{files.length}</span>
      </button>

      {/* Individual files */}
      {files.map((f) => {
        const name = f.file.split("/").pop() ?? f.file;
        const dir = f.file.includes("/") ? f.file.slice(0, f.file.lastIndexOf("/") + 1) : "";
        const isSelected = selectedFile === f.file;

        return (
          <button
            key={f.file}
            onClick={() => onSelectFile(f.file)}
            className={`w-full flex items-center h-6 px-2 text-left transition-colors ${
              isSelected ? "bg-[var(--surface-active)]" : "hover:bg-[var(--surface-hover)]"
            }`}
          >
            <span className="flex-1 min-w-0 truncate">
              {dir && <span className="text-[var(--dim)]">{dir}</span>}
              <span className={isSelected ? "text-[var(--accent)]" : "text-[var(--fg)]"}>
                {name}
              </span>
            </span>
            <span className="shrink-0 flex gap-1.5 ml-2">
              {f.additions > 0 && <span className="text-[var(--green)]">+{f.additions}</span>}
              {f.deletions > 0 && <span className="text-[var(--red)]">-{f.deletions}</span>}
            </span>
          </button>
        );
      })}
    </div>
  );
}
