import { Image, type ImageProps } from 'expo-image';

const sources = {
  orbit: require('../../assets/icons/orbit.svg'),
  alert: require('../../assets/icons/alert.svg'),
  analytics: require('../../assets/icons/analytics.svg'),
  back: require('../../assets/icons/back.svg'),
  book: require('../../assets/icons/book.svg'),
  bookmark: require('../../assets/icons/bookmark.svg'),
  briefcase: require('../../assets/icons/briefcase.svg'),
  'bubble-dots': require('../../assets/icons/bubble-dots.svg'),
  bubbles: require('../../assets/icons/bubbles.svg'),
  bulb: require('../../assets/icons/bulb.svg'),
  cafe: require('../../assets/icons/cafe.svg'),
  camera: require('../../assets/icons/camera.svg'),
  check: require('../../assets/icons/check.svg'),
  'check-circle': require('../../assets/icons/check-circle.svg'),
  'checkbox-off': require('../../assets/icons/checkbox-off.svg'),
  'checkbox-on': require('../../assets/icons/checkbox-on.svg'),
  'chevron-down': require('../../assets/icons/chevron-down.svg'),
  'chevron-up': require('../../assets/icons/chevron-up.svg'),
  circle: require('../../assets/icons/circle.svg'),
  'clear-circle': require('../../assets/icons/clear-circle.svg'),
  close: require('../../assets/icons/close.svg'),
  'cloud-download': require('../../assets/icons/cloud-download.svg'),
  cube: require('../../assets/icons/cube.svg'),
  edit: require('../../assets/icons/edit.svg'),
  export: require('../../assets/icons/export.svg'),
  forward: require('../../assets/icons/forward.svg'),
  gear: require('../../assets/icons/gear.svg'),
  heart: require('../../assets/icons/heart.svg'),
  image: require('../../assets/icons/image.svg'),
  info: require('../../assets/icons/info.svg'),
  moon: require('../../assets/icons/moon.svg'),
  more: require('../../assets/icons/more.svg'),
  people: require('../../assets/icons/people.svg'),
  person: require('../../assets/icons/person.svg'),
  plus: require('../../assets/icons/plus.svg'),
  power: require('../../assets/icons/power.svg'),
  pulse: require('../../assets/icons/pulse.svg'),
  retry: require('../../assets/icons/retry.svg'),
  search: require('../../assets/icons/search.svg'),
  send: require('../../assets/icons/send.svg'),
  sliders: require('../../assets/icons/sliders.svg'),
  sparkles: require('../../assets/icons/sparkles.svg'),
  stop: require('../../assets/icons/stop.svg'),
  sunny: require('../../assets/icons/sunny.svg'),
  clock: require('../../assets/icons/clock.svg'),
  trash: require('../../assets/icons/trash.svg'),
} as const;

// Existing semantic names remain stable while every rendering uses the supplied design.
const names = {
  orbit: 'orbit',
  'chevron-back': 'back', 'chevron-forward': 'forward', 'chevron-down': 'chevron-down', 'chevron-up': 'chevron-up',
  close: 'close', 'close-circle': 'clear-circle', 'ellipsis-horizontal': 'more', 'options-outline': 'sliders',
  refresh: 'retry', 'refresh-outline': 'retry', 'power-outline': 'power', add: 'plus', 'create-outline': 'edit',
  checkmark: 'check', 'checkmark-circle': 'check-circle', 'checkmark-circle-outline': 'check-circle',
  checkbox: 'checkbox-on', 'square-outline': 'checkbox-off', 'ellipse-outline': 'circle',
  'trash-outline': 'trash', 'search-outline': 'search', 'download-outline': 'export', 'camera-outline': 'camera',
  'image-outline': 'image', 'images-outline': 'image', 'pulse-outline': 'pulse', 'cloud-download-outline': 'cloud-download',
  'bulb-outline': 'bulb', 'alert-circle-outline': 'alert', 'information-circle-outline': 'info',
  stop: 'stop', 'arrow-up': 'send', 'chatbubble-ellipses': 'bubble-dots', 'chatbubble-ellipses-outline': 'bubble-dots',
  'chatbubbles-outline': 'bubbles', 'cube-outline': 'cube', 'heart-outline': 'heart', heart: 'heart',
  'person-outline': 'person', 'people-outline': 'people', 'book-outline': 'book',
  'sparkles-outline': 'sparkles', sparkles: 'sparkles', 'settings-outline': 'gear', 'time-outline': 'clock',
  analytics: 'analytics', sunny: 'sunny', cafe: 'cafe', moon: 'moon', briefcase: 'briefcase', bookmark: 'bookmark',
} as const satisfies Record<string, keyof typeof sources>;

export type AppIconName = keyof typeof names;
type AppIconProps = {
  name: AppIconName;
  size?: number;
  color?: string;
  style?: ImageProps['style'];
};

/** Local SVG masks keep the design's proportions; only the theme color changes. */
export function AppIcon({ name, size = 24, color = '#171717', style }: AppIconProps) {
  return <Image source={sources[names[name]]} tintColor={color} contentFit="contain" transition={0}
    alt="" accessible={false} accessibilityElementsHidden importantForAccessibility="no" pointerEvents="none"
    style={[{ width: size, height: size, flexShrink: 0 }, style]} />;
}
