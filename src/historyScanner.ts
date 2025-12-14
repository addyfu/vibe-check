import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * Represents a single version of a file in history
 */
export interface FileVersion {
    source: string;      // Path to the history file
    timestamp: Date;     // When this version was saved
    folderId: string;    // History folder ID
}

/**
 * Represents a file with all its versions
 */
export interface RecoverableFile {
    originalPath: string;
    versions: FileVersion[];
    latestTimestamp: Date;
}

/**
 * Project with its files
 */
export interface Project {
    name: string;
    files: Map<string, RecoverableFile>;
}

/**
 * Get Cursor's data paths based on OS
 */
export function getCursorPaths(): { history: string; db: string } {
    const platform = os.platform();
    
    if (platform === 'win32') {
        const appData = process.env.APPDATA || '';
        return {
            history: path.join(appData, 'Cursor', 'User', 'History'),
            db: path.join(appData, 'Cursor', 'User', 'globalStorage', 'state.vscdb')
        };
    } else if (platform === 'darwin') {
        const home = os.homedir();
        const base = path.join(home, 'Library', 'Application Support', 'Cursor', 'User');
        return {
            history: path.join(base, 'History'),
            db: path.join(base, 'globalStorage', 'state.vscdb')
        };
    } else {
        // Linux
        const home = os.homedir();
        const base = path.join(home, '.config', 'Cursor', 'User');
        return {
            history: path.join(base, 'History'),
            db: path.join(base, 'globalStorage', 'state.vscdb')
        };
    }
}

/**
 * Scans Cursor's history folder for recoverable files
 */
export class HistoryScanner {
    private historyPath: string;
    private cache: Map<string, Project> | null = null;

    constructor() {
        const paths = getCursorPaths();
        this.historyPath = paths.history;
    }

    /**
     * Check if history folder exists
     */
    public historyExists(): boolean {
        return fs.existsSync(this.historyPath);
    }

    /**
     * Get the history path
     */
    public getHistoryPath(): string {
        return this.historyPath;
    }

    /**
     * Scan all files in history and organize by project
     */
    public scanAllFiles(showEmptyVersions: boolean = false): Map<string, Project> {
        if (!this.historyExists()) {
            return new Map();
        }

        const projects = new Map<string, Project>();

        try {
            const folders = fs.readdirSync(this.historyPath);

            for (const folderName of folders) {
                const folderPath = path.join(this.historyPath, folderName);
                
                if (!fs.statSync(folderPath).isDirectory()) {
                    continue;
                }

                const jsonFile = path.join(folderPath, 'entries.json');
                if (!fs.existsSync(jsonFile)) {
                    continue;
                }

                try {
                    const data = JSON.parse(fs.readFileSync(jsonFile, 'utf-8'));
                    const resourcePath = data.resource as string;
                    
                    if (!resourcePath) {
                        continue;
                    }

                    const decodedPath = this.decodePath(resourcePath);
                    const projectName = this.extractProjectName(decodedPath);

                    // Get or create project
                    if (!projects.has(projectName)) {
                        projects.set(projectName, {
                            name: projectName,
                            files: new Map()
                        });
                    }
                    const project = projects.get(projectName)!;

                    // Process entries
                    const entries = data.entries as Array<{ id: string; timestamp: number }>;
                    const versions: FileVersion[] = [];

                    for (const entry of entries) {
                        if (!entry.id || !entry.timestamp) {
                            continue;
                        }

                        const sourceFile = path.join(folderPath, entry.id);
                        if (!fs.existsSync(sourceFile)) {
                            continue;
                        }

                        // Skip empty files unless configured to show them
                        const fileSize = fs.statSync(sourceFile).size;
                        if (!showEmptyVersions && fileSize <= 1) {
                            continue;
                        }

                        versions.push({
                            source: sourceFile,
                            timestamp: new Date(entry.timestamp),
                            folderId: folderName
                        });
                    }

                    if (versions.length > 0) {
                        // Sort by timestamp (newest first)
                        versions.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

                        // Get or update file entry
                        const existingFile = project.files.get(decodedPath);
                        if (existingFile) {
                            existingFile.versions.push(...versions);
                            existingFile.versions.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
                            existingFile.latestTimestamp = existingFile.versions[0].timestamp;
                        } else {
                            project.files.set(decodedPath, {
                                originalPath: decodedPath,
                                versions: versions,
                                latestTimestamp: versions[0].timestamp
                            });
                        }
                    }
                } catch {
                    // Skip files with parse errors
                    continue;
                }
            }
        } catch (error) {
            console.error('Error scanning history:', error);
        }

        this.cache = projects;
        return projects;
    }

    /**
     * Get list of all project names
     */
    public getProjects(): string[] {
        if (!this.cache) {
            this.scanAllFiles();
        }
        return Array.from(this.cache?.keys() || []).sort();
    }

    /**
     * Get files for a specific project
     */
    public getFilesForProject(projectName: string): Map<string, RecoverableFile> {
        if (!this.cache) {
            this.scanAllFiles();
        }
        return this.cache?.get(projectName)?.files || new Map();
    }

    /**
     * Get a specific file's versions
     */
    public getFileVersions(projectName: string, filePath: string): FileVersion[] {
        const files = this.getFilesForProject(projectName);
        return files.get(filePath)?.versions || [];
    }

    /**
     * Read file content from a version
     */
    public readVersionContent(version: FileVersion): string {
        try {
            // Try different encodings
            const encodings: BufferEncoding[] = ['utf-8', 'utf16le', 'latin1'];
            
            for (const encoding of encodings) {
                try {
                    return fs.readFileSync(version.source, { encoding });
                } catch {
                    continue;
                }
            }

            // Fallback: read as binary and show hex
            const buffer = fs.readFileSync(version.source);
            return `[Binary file - ${buffer.length} bytes]\n\n${buffer.toString('hex').slice(0, 2000)}`;
        } catch (error) {
            return `Error reading file: ${error}`;
        }
    }

    /**
     * Clear the cache to force rescan
     */
    public clearCache(): void {
        this.cache = null;
    }

    /**
     * Decode a file:// URI to a local path
     */
    private decodePath(resourcePath: string): string {
        let decoded = decodeURIComponent(resourcePath.replace('file:///', ''));
        
        if (os.platform() === 'win32') {
            decoded = decoded.replace(/\//g, '\\');
            // Fix drive letter
            if (decoded.length > 2 && decoded[1] === ':') {
                decoded = decoded[0].toUpperCase() + decoded.slice(1);
            }
        }
        
        return decoded;
    }

    /**
     * Extract project name from file path
     */
    private extractProjectName(filePath: string): string {
        const parts = filePath.replace(/\\/g, '/').split('/').filter(p => p && !(p.length === 2 && p[1] === ':'));
        
        const skipFolders = new Set([
            'users', 'user', 'home', 'documents', 'desktop',
            'downloads', 'study', 'projects', 'code', 'dev', 'src'
        ]);

        for (const part of parts) {
            if (!skipFolders.has(part.toLowerCase())) {
                return part;
            }
        }

        return parts.length >= 2 ? parts[parts.length - 2] : 'Unknown Project';
    }
}

/**
 * Utility class for file recovery operations
 */
export class FileRecovery {
    /**
     * Copy a file from history to destination
     */
    public static restoreFile(sourcePath: string, destPath: string): void {
        const destDir = path.dirname(destPath);
        if (!fs.existsSync(destDir)) {
            fs.mkdirSync(destDir, { recursive: true });
        }
        fs.copyFileSync(sourcePath, destPath);
    }

    /**
     * Get relative path within a project
     */
    public static getRelativePath(filePath: string, projectName: string): string {
        const normalized = filePath.replace(/\\/g, '/');
        const parts = normalized.split('/');
        
        const idx = parts.findIndex(p => p.toLowerCase() === projectName.toLowerCase());
        if (idx !== -1 && idx < parts.length - 1) {
            return parts.slice(idx + 1).join('/');
        }
        
        return path.basename(filePath);
    }
}




