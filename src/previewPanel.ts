import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { FileVersion } from './historyScanner';
import { RecoveryTreeProvider, RecoveryTreeItem } from './recoveryTreeProvider';

/**
 * Single webview panel with toolbar at top and code preview below
 * Uses highlight.js for syntax highlighting
 */
export class PreviewPanel {
    public static currentPanel: PreviewPanel | undefined;
    private static _treeProvider: RecoveryTreeProvider;
    private static _currentFile: RecoveryTreeItem | null = null;
    private static _currentVersionIndex: number = 0;

    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private _disposables: vscode.Disposable[] = [];

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
        this._panel = panel;
        this._extensionUri = extensionUri;

        // Handle messages from webview
        this._panel.webview.onDidReceiveMessage(
            async message => {
                switch (message.command) {
                    case 'older':
                        await PreviewPanel.olderVersion();
                        break;
                    case 'newer':
                        await PreviewPanel.newerVersion();
                        break;
                    case 'copy':
                        PreviewPanel.copyContent();
                        break;
                    case 'recover':
                        vscode.commands.executeCommand('vibeCheck.recoverCurrentFile');
                        break;
                    case 'diff':
                        await PreviewPanel.showDiff();
                        break;
                    case 'selectVersion':
                        await PreviewPanel.selectVersion(message.index);
                        break;
                }
            },
            null,
            this._disposables
        );

        // Handle panel disposal
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    }

    /**
     * Create or show the preview panel
     */
    public static async createOrShow(
        extensionUri: vscode.Uri,
        treeProvider: RecoveryTreeProvider,
        file?: RecoveryTreeItem
    ): Promise<PreviewPanel | undefined> {
        PreviewPanel._treeProvider = treeProvider;

        if (file) {
            PreviewPanel._currentFile = file;
            PreviewPanel._currentVersionIndex = 0;
        }

        const column = vscode.ViewColumn.One;

        // If panel exists, just update content
        if (PreviewPanel.currentPanel) {
            PreviewPanel.currentPanel._panel.reveal(column);
            PreviewPanel.currentPanel._update();
            return PreviewPanel.currentPanel;
        }

        // Create new panel
        const panel = vscode.window.createWebviewPanel(
            'vibeCheckPreview',
            'Vibe Check',
            column,
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );

        PreviewPanel.currentPanel = new PreviewPanel(panel, extensionUri);
        PreviewPanel.currentPanel._update();

        return PreviewPanel.currentPanel;
    }

    /**
     * Update the webview content
     */
    private _update(): void {
        if (!PreviewPanel._currentFile?.versions || PreviewPanel._currentFile.versions.length === 0) {
            this._panel.webview.html = this._getEmptyHtml();
            return;
        }

        const versions = PreviewPanel._currentFile.versions;
        const version = versions[PreviewPanel._currentVersionIndex];
        const fileName = path.basename(PreviewPanel._currentFile.filePath || 'file');
        const totalVersions = versions.length;
        const currentIdx = PreviewPanel._currentVersionIndex;

        // Read file content
        let content = '';
        try {
            content = fs.readFileSync(version.source, 'utf-8');
        } catch {
            try {
                content = fs.readFileSync(version.source, 'latin1');
            } catch {
                content = '// Error reading file';
            }
        }

        // Update panel title
        const versionText = currentIdx === 0 ? 'Latest' : `v${totalVersions - currentIdx}`;
        this._panel.title = `${fileName} (${versionText})`;

        // Get language for syntax highlighting
        const ext = path.extname(fileName).slice(1).toLowerCase();
        const language = this._getLanguage(ext);

        // Build versions list for dropdown
        const allVersions = versions.map((v, i) => ({
            timestamp: v.timestamp,
            index: i
        }));

        this._panel.webview.html = this._getHtml(
            fileName,
            content,
            language,
            currentIdx,
            totalVersions,
            version.timestamp,
            allVersions
        );
    }

    /**
     * Map file extension to highlight.js language
     */
    private _getLanguage(ext: string): string {
        const langMap: { [key: string]: string } = {
            'js': 'javascript',
            'jsx': 'javascript',
            'ts': 'typescript',
            'tsx': 'typescript',
            'py': 'python',
            'rb': 'ruby',
            'java': 'java',
            'c': 'c',
            'cpp': 'cpp',
            'h': 'c',
            'hpp': 'cpp',
            'cs': 'csharp',
            'go': 'go',
            'rs': 'rust',
            'php': 'php',
            'swift': 'swift',
            'kt': 'kotlin',
            'scala': 'scala',
            'r': 'r',
            'sql': 'sql',
            'sh': 'bash',
            'bash': 'bash',
            'zsh': 'bash',
            'ps1': 'powershell',
            'html': 'xml',
            'htm': 'xml',
            'xml': 'xml',
            'css': 'css',
            'scss': 'scss',
            'sass': 'scss',
            'less': 'less',
            'json': 'json',
            'yaml': 'yaml',
            'yml': 'yaml',
            'md': 'markdown',
            'markdown': 'markdown',
            'txt': 'plaintext',
            'vue': 'xml',
            'svelte': 'xml'
        };
        return langMap[ext] || 'plaintext';
    }

    /**
     * Generate HTML with toolbar and code
     */
    private _getHtml(
        fileName: string,
        content: string,
        language: string,
        currentIdx: number,
        totalVersions: number,
        timestamp: Date,
        allVersions: { timestamp: Date; index: number }[]
    ): string {
        const versionText = currentIdx === 0 ? 'Latest' : `v${totalVersions - currentIdx}/${totalVersions}`;

        const isOldestDisabled = currentIdx >= totalVersions - 1;
        const isNewestDisabled = currentIdx <= 0;
        const canDiff = !isOldestDisabled;

        // Escape HTML
        const escapedContent = content
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');

        // Build version dropdown options
        const versionOptions = allVersions.map((v, i) => {
            const label = i === 0 ? 'Latest' : `Version ${totalVersions - i}`;
            const dateStr = v.timestamp.toLocaleString();
            const selected = i === currentIdx ? 'selected' : '';
            return `<option value="${i}" ${selected}>${label} - ${dateStr}</option>`;
        }).join('');

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/vs2015.min.css">
    <script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"></script>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        
        html {
            height: 100%;
            width: 100%;
            overflow: hidden;
            background: #1e1e1e;
        }
        
        body {
            /* Use 100% of available space */
            height: 100%;
            width: 100%;
            overflow: hidden;
            background: #1e1e1e;
            color: #ccc;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            display: flex;
            flex-direction: column;
        }
        
        /* Wrapper that breaks out of VS Code padding */
        .wrapper {
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            display: flex;
            flex-direction: column;
            background: #1e1e1e;
        }
        
        /* Toolbar */
        .toolbar {
            background: #252526;
            border-bottom: 1px solid #3c3c3c;
            padding: 8px 12px;
            display: flex;
            align-items: center;
            gap: 8px;
            flex-shrink: 0;
            min-height: 44px;
            flex-wrap: wrap;
            overflow: hidden;
        }
        
        .toolbar-left {
            display: flex;
            align-items: center;
            gap: 8px;
            flex-shrink: 1;
            min-width: 0;
            overflow: hidden;
        }
        
        .toolbar-center {
            display: flex;
            align-items: center;
            gap: 6px;
            flex-shrink: 0;
        }
        
        .toolbar-right {
            display: flex;
            align-items: center;
            gap: 6px;
            flex-shrink: 0;
            margin-left: auto;
        }
        
        .file-info {
            font-size: 13px;
            font-weight: 600;
            color: #e0e0e0;
            padding: 5px 10px;
            background: #3c3c3c;
            border-radius: 4px;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            max-width: 180px;
            flex-shrink: 1;
            min-width: 60px;
        }
        
        .version-select {
            font-size: 12px;
            padding: 5px 8px;
            background: #3c3c3c;
            color: #4ec9b0;
            border: 1px solid #4a4a4a;
            border-radius: 4px;
            cursor: pointer;
            outline: none;
            min-width: 140px;
            max-width: 220px;
            flex-shrink: 1;
        }
        .version-select:hover { background: #4a4a4a; }
        .version-select:focus { border-color: #0e639c; }
        
        .btn {
            padding: 5px 10px;
            border: none;
            border-radius: 4px;
            font-size: 12px;
            cursor: pointer;
            transition: background 0.15s;
            font-family: inherit;
            background: #3c3c3c;
            color: #ccc;
            font-weight: 500;
            white-space: nowrap;
            flex-shrink: 0;
        }
        
        .btn:hover:not(:disabled) { background: #4a4a4a; }
        .btn:disabled { opacity: 0.4; cursor: not-allowed; }
        
        .btn-primary { background: #0e639c; color: #fff; }
        .btn-primary:hover:not(:disabled) { background: #1177bb; }
        
        .btn-danger { background: #c42b1c; color: #fff; }
        .btn-danger:hover:not(:disabled) { background: #d63a2b; }
        
        .sep { width: 1px; height: 20px; background: #4a4a4a; margin: 0 2px; flex-shrink: 0; }
        .spacer { flex: 1; min-width: 8px; }
        .meta { font-size: 11px; color: #888; white-space: nowrap; font-weight: 500; flex-shrink: 0; }
        
        /* Responsive: hide less important elements on narrow widths */
        @media (max-width: 500px) {
            .sep { display: none; }
            .meta { display: none; }
            .spacer { display: none; }
            .toolbar { justify-content: flex-start; }
        }
        
        @media (max-width: 400px) {
            .file-info { max-width: 100px; }
            .version-select { min-width: 100px; max-width: 140px; }
            .btn { padding: 5px 8px; font-size: 11px; }
        }
        
        /* Code container */
        .code-container {
            flex: 1;
            overflow: auto;
            background: #1e1e1e;
        }
        
        pre {
            margin: 0;
            background: #1e1e1e !important;
            padding: 8px 12px;
            min-height: 100%;
        }
        
        pre code {
            font-family: 'Consolas', 'Monaco', monospace;
            font-size: 13px;
            line-height: 1.5;
            display: block;
            padding: 0;
        }
        
        .hljs { 
            background: #1e1e1e !important;
            padding: 0 !important;
        }
        
        /* Scrollbar */
        .code-container::-webkit-scrollbar { width: 14px; height: 14px; }
        .code-container::-webkit-scrollbar-track { background: #1e1e1e; }
        .code-container::-webkit-scrollbar-thumb { 
            background: #424242; 
            border: 3px solid #1e1e1e;
            border-radius: 7px;
        }
        .code-container::-webkit-scrollbar-thumb:hover { background: #555; }
        .code-container::-webkit-scrollbar-corner { background: #1e1e1e; }
    </style>
</head>
<body>
    <div class="wrapper">
    <div class="toolbar">
        <div class="toolbar-left">
            <span class="file-info" title="${fileName}">${fileName}</span>
            <select class="version-select" onchange="selectVersion(this.value)" title="Select version">
                ${versionOptions}
            </select>
        </div>
        
        <div class="toolbar-center">
            <div class="sep"></div>
            <button class="btn" onclick="send('older')" ${isOldestDisabled ? 'disabled' : ''} title="View older version">← Older</button>
            <button class="btn" onclick="send('newer')" ${isNewestDisabled ? 'disabled' : ''} title="View newer version">Newer →</button>
            <div class="sep"></div>
        </div>
        
        <div class="toolbar-right">
            <button class="btn" onclick="send('diff')" ${!canDiff ? 'disabled' : ''} title="Compare with previous version">Diff</button>
            <button class="btn btn-primary" onclick="send('copy')" title="Copy to clipboard">Copy</button>
            <button class="btn btn-danger" onclick="send('recover')" title="Recover this file">Recover</button>
        </div>
        
        <div class="spacer"></div>
        <span class="meta">${totalVersions} versions</span>
    </div>
    
    <div class="code-container">
        <pre><code class="language-${language}">${escapedContent}</code></pre>
    </div>
    </div>
    
    <script>
        const vscode = acquireVsCodeApi();
        function send(cmd) { vscode.postMessage({ command: cmd }); }
        function selectVersion(idx) { vscode.postMessage({ command: 'selectVersion', index: parseInt(idx) }); }
        hljs.highlightAll();
    </script>
</body>
</html>`;
    }

    /**
     * Empty state HTML
     */
    private _getEmptyHtml(): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <style>
        body {
            background: #1e1e1e;
            color: #888;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            display: flex;
            align-items: center;
            justify-content: center;
            height: 100vh;
            text-align: center;
        }
        .message { font-size: 16px; }
    </style>
</head>
<body>
    <div class="message">
        📂 Select a file from the Vibe Check sidebar to preview
    </div>
</body>
</html>`;
    }

    /**
     * Select a specific version by index
     */
    public static async selectVersion(index: number): Promise<void> {
        if (!PreviewPanel._currentFile?.versions) {
            return;
        }

        if (index >= 0 && index < PreviewPanel._currentFile.versions.length) {
            PreviewPanel._currentVersionIndex = index;
            PreviewPanel.currentPanel?._update();
        }
    }

    /**
     * Navigate to older version
     */
    public static async olderVersion(): Promise<void> {
        if (!PreviewPanel._currentFile?.versions) {
            return;
        }

        if (PreviewPanel._currentVersionIndex < PreviewPanel._currentFile.versions.length - 1) {
            PreviewPanel._currentVersionIndex++;
            PreviewPanel.currentPanel?._update();
        } else {
            vscode.window.showInformationMessage('This is the oldest version');
        }
    }

    /**
     * Navigate to newer version
     */
    public static async newerVersion(): Promise<void> {
        if (!PreviewPanel._currentFile?.versions) {
            return;
        }

        if (PreviewPanel._currentVersionIndex > 0) {
            PreviewPanel._currentVersionIndex--;
            PreviewPanel.currentPanel?._update();
        } else {
            vscode.window.showInformationMessage('This is the latest version');
        }
    }

    /**
     * Show diff between current and previous version
     */
    public static async showDiff(): Promise<void> {
        if (!PreviewPanel._currentFile?.versions || PreviewPanel._currentFile.versions.length < 2) {
            vscode.window.showInformationMessage('Need at least 2 versions to compare');
            return;
        }

        const currentIdx = PreviewPanel._currentVersionIndex;
        const olderIdx = Math.min(currentIdx + 1, PreviewPanel._currentFile.versions.length - 1);

        if (currentIdx === olderIdx) {
            vscode.window.showInformationMessage('This is the oldest version, nothing to compare');
            return;
        }

        const currentVersion = PreviewPanel._currentFile.versions[currentIdx];
        const olderVersion = PreviewPanel._currentFile.versions[olderIdx];
        const fileName = path.basename(PreviewPanel._currentFile.filePath || 'file');

        const currentUri = vscode.Uri.file(currentVersion.source);
        const olderUri = vscode.Uri.file(olderVersion.source);

        await vscode.commands.executeCommand(
            'vscode.diff',
            olderUri,
            currentUri,
            `${fileName}: Older ↔ Current`
        );
    }

    /**
     * Copy current content to clipboard
     */
    public static copyContent(): void {
        if (!PreviewPanel._currentFile?.versions) {
            return;
        }

        const version = PreviewPanel._currentFile.versions[PreviewPanel._currentVersionIndex];
        const content = PreviewPanel._treeProvider.readVersionContent(version);
        vscode.env.clipboard.writeText(content);
        vscode.window.showInformationMessage('✓ Vibe copied to clipboard!');
    }

    /**
     * Get current file for recovery
     */
    public static getCurrentFile(): RecoveryTreeItem | null {
        return PreviewPanel._currentFile;
    }

    /**
     * Get current version index
     */
    public static getCurrentVersionIndex(): number {
        return PreviewPanel._currentVersionIndex;
    }

    /**
     * Dispose resources
     */
    public dispose(): void {
        PreviewPanel.currentPanel = undefined;
        PreviewPanel._currentFile = null;
        PreviewPanel._currentVersionIndex = 0;

        this._panel.dispose();

        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) {
                x.dispose();
            }
        }
    }
}
