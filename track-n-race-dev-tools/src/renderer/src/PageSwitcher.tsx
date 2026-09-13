import { useMemo } from 'react'
import type { SingleValue } from 'react-select'
import AnimatedSelect from './pages/tnrd/AnimatedSelect'
import { buildSelectStyles } from './pages/tnrd/selectStyles'
import type { ToolPage } from './types'

interface PageOption {
  value: ToolPage
  label: string
}

const options: PageOption[] = [
  { value: 'tnrd', label: 'TNRD Viewer' },
  { value: 'ram', label: 'RAM Usage Viewer' },
]

export default function PageSwitcher({ value, onChange, isDark }: { value: ToolPage; onChange: (page: ToolPage) => void; isDark: boolean }) {
  const styles = useMemo(() => buildSelectStyles(isDark, {
    transparentControl: true,
    controlHeight: 30,
    menuWidth: 190,
    scrollableMenu: false,
  }), [isDark])

  return (
    <div className="page-switcher no-drag">
      <AnimatedSelect<PageOption>
        aria-label="Developer tool"
        value={options.find(option => option.value === value)}
        options={options}
        onChange={(option: SingleValue<PageOption>) => { if (option) onChange(option.value) }}
        styles={styles}
        menuPortalTarget={document.body}
        isSearchable={false}
      />
    </div>
  )
}
