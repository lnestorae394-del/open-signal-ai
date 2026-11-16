import { ALWAYS_OPEN_MODULES, type BindingState, type BotConfig, type ModuleId } from '@open-signal/shared';

/**
 * Access policy. Rules, in order:
 *  1. a module switched off for the bot is unavailable;
 *  2. Academy, the demo simulator and Profile are ALWAYS open — no binding,
 *     no deposit, regardless of configuration;
 *  3. other modules require `account_bound` only if Account Binding is enabled
 *     and the module is listed in gatedModules.
 * Financial events (FTD/deposit) are not an input here at all.
 */
export function isModuleAccessible(module: ModuleId, config: Pick<BotConfig, 'modules' | 'accountBinding'>, state: BindingState): boolean {
  if (config.modules[module] === false) return false;
  if (ALWAYS_OPEN_MODULES.includes(module)) return true;
  if (!config.modules.account_binding) return true;
  if (!config.accountBinding.gatedModules.includes(module)) return true;
  return state === 'account_bound';
}

export function accessMap(config: Pick<BotConfig, 'modules' | 'accountBinding'>, state: BindingState): Record<ModuleId, boolean> {
  const out = {} as Record<ModuleId, boolean>;
  for (const m of Object.keys(config.modules) as ModuleId[]) out[m] = isModuleAccessible(m, config, state);
  return out;
}
