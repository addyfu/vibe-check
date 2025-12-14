import * as vscode from 'vscode';
import * as path from 'path';
import { HistoryScanner, RecoverableFile, FileVersion } from './historyScanner';

/**
 * Tree item representing a file or folder in the recovery explorer
 */
export class RecoveryTreeItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly filePath?: string,
        public readonly versions?: FileVersion[],
        public readonly isFolder: boolean = false
    ) {
        super(label, collapsibleState);
        
        if (!isFolder && filePath && versions) {
            // File item
            this.contextValue = 'file';
            this.tooltip = `${filePath}\n${versions.length} version(s)`;
            this.description = `${versions.length} vibes`;
            this.iconPath = this.getFileIcon(filePath);
            
            // Click to preview
            this.command = {
                command: 'vibeCheck.preview',
                title: 'Preview',
                arguments: [this]
            };
        } else {
            // Folder item
            this.contextValue = 'folder';
            this.iconPath = new vscode.ThemeIcon('folder');
        }
    }

    private getFileIcon(filePath: string): vscode.ThemeIcon {
        const ext = path.extname(filePath).toLowerCase();
        const iconMap: Record<string, string> = {
            '.py': 'symbol-method',
            '.js': 'symbol-variable',
            '.ts': 'symbol-class',
            '.tsx': 'symbol-interface',
            '.jsx': 'symbol-interface',
            '.html': 'globe',
            '.css': 'symbol-color',
            '.json': 'json',
            '.md': 'markdown',
            '.txt': 'file-text',
            '.yml': 'settings-gear',
            '.yaml': 'settings-gear',
            '.xml': 'file-code',
            '.sql': 'database',
            '.sh': 'terminal',
            '.bat': 'terminal',
            '.ps1': 'terminal',
            '.env': 'lock',
            '.gitignore': 'git-commit',
            '.svg': 'file-media',
            '.png': 'file-media',
            '.jpg': 'file-media',
            '.jpeg': 'file-media',
            '.gif': 'file-media',
        };
        
        return new vscode.ThemeIcon(iconMap[ext] || 'file');
    }
}

/**
 * Provides data for the recovery explorer tree view
 */
export class RecoveryTreeProvider implements vscode.TreeDataProvider<RecoveryTreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<RecoveryTreeItem | undefined | null | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private scanner: HistoryScanner;
    private currentProject: string | null = null;
    private fileTree: Map<string, RecoverableFile> = new Map();

    constructor() {
        this.scanner = new HistoryScanner();
    }

    /**
     * Refresh the tree view
     */
    public refresh(): void {
        this.scanner.clearCache();
        this.scanner.scanAllFiles();
        if (this.currentProject) {
            this.fileTree = this.scanner.getFilesForProject(this.currentProject);
        }
        this._onDidChangeTreeData.fire();
    }

    /**
     * Get list of available projects
     */
    public getProjects(): string[] {
        return this.scanner.getProjects();
    }

    /**
     * Set the current project to display
     */
    public setProject(projectName: string): void {
        this.currentProject = projectName;
        this.fileTree = this.scanner.getFilesForProject(projectName);
        this._onDidChangeTreeData.fire();
    }

    /**
     * Get current project name
     */
    public getCurrentProject(): string | null {
        return this.currentProject;
    }

    /**
     * Get all files in current project
     */
    public getAllFiles(): Map<string, RecoverableFile> {
        return this.fileTree;
    }

    /**
     * Check if history exists
     */
    public historyExists(): boolean {
        return this.scanner.historyExists();
    }

    /**
     * Get history path
     */
    public getHistoryPath(): string {
        return this.scanner.getHistoryPath();
    }

    /**
     * Read content of a specific version
     */
    public readVersionContent(version: FileVersion): string {
        return this.scanner.readVersionContent(version);
    }

    // TreeDataProvider implementation

    getTreeItem(element: RecoveryTreeItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: RecoveryTreeItem): Thenable<RecoveryTreeItem[]> {
        if (!this.currentProject) {
            return Promise.resolve([
                new RecoveryTreeItem(
                    '✓ Select a project to check vibes',
                    vscode.TreeItemCollapsibleState.None
                )
            ]);
        }

        if (!element) {
            // Root level - build folder structure
            return Promise.resolve(this.buildTree());
        }

        // Children of a folder
        if (element.isFolder) {
            return Promise.resolve(this.getChildrenForFolder(element.label));
        }

        return Promise.resolve([]);
    }

    /**
     * Build the tree structure from files
     */
    private buildTree(): RecoveryTreeItem[] {
        const folders = new Map<string, RecoverableFile[]>();
        const rootFiles: RecoverableFile[] = [];

        // Organize files into folders
        for (const [filePath, file] of this.fileTree) {
            const relativePath = this.getRelativePath(filePath);
            const parts = relativePath.replace(/\\/g, '/').split('/');
            
            if (parts.length > 1) {
                const folder = parts[0];
                if (!folders.has(folder)) {
                    folders.set(folder, []);
                }
                folders.get(folder)!.push(file);
            } else {
                rootFiles.push(file);
            }
        }

        const items: RecoveryTreeItem[] = [];

        // Add folders
        for (const [folderName, files] of Array.from(folders.entries()).sort()) {
            items.push(new RecoveryTreeItem(
                folderName,
                vscode.TreeItemCollapsibleState.Expanded,
                undefined,
                undefined,
                true
            ));
        }

        // Add root files
        for (const file of rootFiles.sort((a, b) => 
            path.basename(a.originalPath).localeCompare(path.basename(b.originalPath))
        )) {
            items.push(new RecoveryTreeItem(
                path.basename(file.originalPath),
                vscode.TreeItemCollapsibleState.None,
                file.originalPath,
                file.versions,
                false
            ));
        }

        return items;
    }

    /**
     * Get children for a specific folder
     */
    private getChildrenForFolder(folderName: string): RecoveryTreeItem[] {
        const items: RecoveryTreeItem[] = [];
        const subFolders = new Map<string, RecoverableFile[]>();
        const files: RecoverableFile[] = [];

        for (const [filePath, file] of this.fileTree) {
            const relativePath = this.getRelativePath(filePath);
            const parts = relativePath.replace(/\\/g, '/').split('/');
            
            if (parts.length > 1 && parts[0] === folderName) {
                if (parts.length > 2) {
                    // Nested folder
                    const subFolder = parts[1];
                    if (!subFolders.has(subFolder)) {
                        subFolders.set(subFolder, []);
                    }
                    subFolders.get(subFolder)!.push(file);
                } else {
                    // Direct file in this folder
                    files.push(file);
                }
            }
        }

        // Add subfolders (for now, we flatten - can make recursive later)
        // Add files
        for (const file of files.sort((a, b) => 
            path.basename(a.originalPath).localeCompare(path.basename(b.originalPath))
        )) {
            items.push(new RecoveryTreeItem(
                path.basename(file.originalPath),
                vscode.TreeItemCollapsibleState.None,
                file.originalPath,
                file.versions,
                false
            ));
        }

        return items;
    }

    /**
     * Get relative path for a file
     */
    private getRelativePath(filePath: string): string {
        if (!this.currentProject) {
            return path.basename(filePath);
        }
        
        const normalized = filePath.replace(/\\/g, '/');
        const parts = normalized.split('/');
        
        const idx = parts.findIndex(p => p.toLowerCase() === this.currentProject!.toLowerCase());
        if (idx !== -1 && idx < parts.length - 1) {
            return parts.slice(idx + 1).join('/');
        }
        
        return path.basename(filePath);
    }
}


