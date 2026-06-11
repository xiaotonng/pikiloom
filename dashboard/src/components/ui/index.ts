/**
 * UI primitives — single barrel for `import { … } from '../components/ui'`.
 *
 * Three tiers:
 *
 *   1. Foundation     tokens, variants    — design tokens + variant resolver
 *   2. Primitives     Button, Badge, Card, Input, Modal, Select, …
 *   3. Composites     StatusPill, AmbientGlow, Row.*, Section, Heading, Text
 *
 * Conventions:
 *   - Components own their CSS through Tailwind classes that reference the
 *     CSS variables in `index.css`. Theme switching = re-render-free.
 *   - Variants live in typed `tv()` configs; pages choose semantically.
 *   - No component imports another component from outside this folder.
 */

// Foundation
export * from './tokens';
export * from './variants';

// Primitives
export { Card, type CardElevation, type CardTone, type CardPadding } from './Card';
export { Badge, Dot, CountBadge, type BadgeTone, type DotTone } from './Badge';
export { Button, type ButtonProps, type ButtonTone, type ButtonSize, type ButtonShape } from './Button';
export { Input, Label, type InputProps } from './Input';
export { Select, IconPicker } from './Select';
export { ModelSelect } from './ModelSelect';
export { Modal, ModalHeader, type ModalSize } from './Modal';
export { TabsList, TabsTrigger } from './Tabs';
export { Tooltip, type TooltipProps } from './Tooltip';
export { ChevronIcon, CollapsibleCard } from './Collapsible';
export { SectionLabel, Skeleton, Spinner, Toasts } from './feedback';

// Composites
export { StatusPill, type StatusState } from './StatusPill';
export { AmbientGlow } from './AmbientGlow';
export { Row, RowGroup, Section } from './Row';
export { Heading, Text, Mono, type TextVariant } from './Typography';
export {
  Field, type FieldProps,
  Metric,
  DescriptionList,
  EmptyState,
  PageHeader, type PageHeaderProps,
  Tile, type TileProps,
  LoadingDots,
} from './DataDisplay';
