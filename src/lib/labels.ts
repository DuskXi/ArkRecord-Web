/** 卡池规则类型的显示名与配色 */
const LABELS: Record<string, { label: string; color: 'primary' | 'warning' | 'error' | 'success' | 'neutral' | 'info' }> = {
  LIMITED: { label: '限定', color: 'error' },
  LINKAGE: { label: '联动', color: 'warning' },
  SINGLE: { label: '单 UP', color: 'info' },
  DOUBLE: { label: '双 UP', color: 'info' },
  NORMAL: { label: '标准', color: 'neutral' },
  SPECIAL: { label: '定向甄选', color: 'success' },
  CLASSIC: { label: '中坚', color: 'neutral' },
  CLASSIC_DOUBLE: { label: '中坚双 UP', color: 'info' },
  FESCLASSIC: { label: '中坚甄选', color: 'success' },
  ATTAIN: { label: '跨年欢庆', color: 'warning' },
  CLASSIC_ATTAIN: { label: '中坚欢庆', color: 'warning' },
  BACKFLOW: { label: '归航', color: 'neutral' },
  BOOT: { label: '新手', color: 'neutral' },
  E_CharacterGachaPoolType_Special: { label: '特许寻访', color: 'error' },
  E_CharacterGachaPoolType_Rerun: { label: '重构寻访', color: 'warning' },
  E_CharacterGachaPoolType_Joint: { label: '辉光庆典', color: 'success' },
  E_CharacterGachaPoolType_Standard: { label: '基础寻访', color: 'neutral' },
  E_CharacterGachaPoolType_Beginner: { label: '启程寻访', color: 'neutral' },
}

export function ruleLabel(ruleType: string) {
  if (ruleType.startsWith('weapon:')) return { label: '武器', color: 'info' as const }
  return LABELS[ruleType] ?? { label: ruleType, color: 'neutral' as const }
}
