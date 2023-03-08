import { workspace } from 'vscode';
import { FossilUsername } from './fossilBase';

const DEFAULT_AUTO_IN_OUT_INTERVAL_SECONDS = 3 * 60; /* three minutes */

class Config {
    private get config() {
        return workspace.getConfiguration('fossil');
    }

    private get<T>(name: keyof Config, defaultValue: T): T {
        return this.config.get<T>(name, defaultValue);
    }

    get enabled(): boolean {
        return this.get('enabled', true);
    }

    get path(): string | undefined {
        return this.get('path', undefined);
    }

    /**
     * Enables automatic update of working directory to branch head
     * after pulling (equivalent to fossil update)
     */
    get autoUpdate(): boolean {
        return this.get('autoUpdate', true);
    }

    /**
     * Enables automatic refreshing of Source Control tab and badge
     * counter when files within the project change.
     */
    get autoRefresh(): boolean {
        return this.get('autoRefresh', true);
    }

    get autoInOutInterval(): number {
        return this.get(
            'autoInOutInterval',
            DEFAULT_AUTO_IN_OUT_INTERVAL_SECONDS
        );
    }

    get autoInOutIntervalMs(): number {
        return this.autoInOutInterval * 1000;
    }

    get username(): FossilUsername | undefined {
        return this.get('username', undefined);
    }
}

const typedConfig = new Config();
export default typedConfig;
