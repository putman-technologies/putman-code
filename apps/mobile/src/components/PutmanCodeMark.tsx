import type { ColorValue } from "react-native";
import Svg, { Path } from "react-native-svg";
import { withUniwind } from "uniwind";

const ThemedPath = withUniwind(Path);

export function PutmanCodeMark(props: {
  readonly height: number;
  readonly color?: ColorValue;
  readonly colorClassName?: string;
}) {
  return (
    <Svg
      accessibilityLabel="PutmanCode"
      height={props.height}
      width={props.height}
      viewBox="0 0 24 24"
    >
      <ThemedPath
        d="m4 6 6 6-6 6 2 2 8-8-8-8zm10 11h7v3h-7z"
        color={props.color}
        colorClassName={props.colorClassName}
        fill="currentColor"
      />
    </Svg>
  );
}
