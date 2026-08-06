from math import sin,cos
from os import path,urandom
import random
from io import BytesIO
from PIL import Image, ImageDraw, ImageFilter, ImageFont
from base64 import b64encode

class CaptchaGenerator:
    """
    High-Performance CAPTCHA generator.
    Optimized for speed, avoiding redundant object creation and loop overhead.
    """

    def __init__(
        self,
        width: int = 400,
        height: int = 120,
        length: int = 4,
        fonts: list[str] | None = None,
        char_set: str = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789",
    ):
        # --- Base Configuration ---
        self.width = width
        self.height = height
        self.length = length
        self.char_set = char_set

        # --- Visual Tuning Parameters ---
        self.font_size_range = (62, 72)
        self.char_rotation_limit = 30  
        
        self.bg_color_range = (200, 255)
        # Grouped text colors (R_min, R_max, G_min, G_max, B_min, B_max) for faster unpacking
        self.text_color_range = (0, 80, 0, 80, 100, 200) 
        self.noise_color_range = (120, 200)
        self.line_color_range = (50, 150)
        
        self.bg_alpha_noise = 0.04  
        self.noise_points_range = (60, 100)
        self.bg_arcs_range = (1, 4)
        self.fg_lines_range = (1, 2)
        
        self.blur_radius = 0.4
        self.warp_amplitude = (1.5, 3.0)
        self.warp_frequency = (0.03, 0.05)

        # --- Font Caching Setup ---
        font_paths = fonts or ["arial.ttf", "calibri.ttf", "times.ttf"]
        self.valid_fonts = [p for p in font_paths if path.exists(p)]
        self._font_cache: dict[tuple[str, int] | int, ImageFont.FreeTypeFont | ImageFont.ImageFont] = {}

    def _get_font(self, size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
        """Fetches fonts from memory to avoid expensive disk I/O."""
        if not self.valid_fonts:
            if size not in self._font_cache:
                self._font_cache[size] = ImageFont.load_default()
            return self._font_cache[size]

        font_path = random.choice(self.valid_fonts)
        key = (font_path, size)
        
        if key not in self._font_cache:
            self._font_cache[key] = ImageFont.truetype(font_path, size)
        return self._font_cache[key]

    def _apply_sine_warp(self, image: Image.Image) -> Image.Image:
        """Applies a gentle non-linear sine wave mesh distortion."""
        w, h = image.size
        amp = random.uniform(*self.warp_amplitude) 
        freq = random.uniform(*self.warp_frequency)
        grid = 12

        # Pad the list length by 2 to ensure we never get an IndexError on the boundaries
        x_points = (w // grid) + 2
        y_points = (h // grid) + 2

        sin_y = [sin(y * grid * freq) * amp for y in range(y_points)]
        cos_x = [cos(x * grid * freq) * amp for x in range(x_points)]

        mesh = []
        append = mesh.append  # Localize function for loop speed

        # Iterating directly by range prevents zero-width bounding boxes at the borders
        for x in range(0, w, grid):
            i = x // grid
            x1 = min(x + grid, w)
            cx = cos_x[i]
            cx1 = cos_x[i + 1]

            for y in range(0, h, grid):
                j = y // grid
                y1 = min(y + grid, h)
                sy = sin_y[j]
                sy1 = sin_y[j + 1]

                append((
                    (x, y, x1, y1),
                    (x + sy, y + cx, x + sy, y1 + cx1, x1 + sy1, y1 + cx1, x1 + sy1, y + cx)
                ))

        return image.transform((w, h), Image.Transform.MESH, mesh, Image.Resampling.BILINEAR)
    def _rand_color(self, color_range: tuple[int, int]) -> tuple[int, int, int]:
        """Helper to quickly generate RGB tuples from a range."""
        rand = random.randint
        return (rand(*color_range), rand(*color_range), rand(*color_range))

    def generate(self, blend_factor: float = 0.5) -> tuple[Image.Image, str]:
        text = "".join(random.choice(self.char_set) for _ in range(self.length))
        rand = random.randint
        w, h = self.width, self.height

        # 1. Base canvas & subtle noise blending
        bg_color = self._rand_color(self.bg_color_range)
        image = Image.new("RGB", (w, h), bg_color)

        noise_bytes = urandom(w * h * 3)
        noise_layer = Image.frombytes("RGB", (w, h), noise_bytes)
        image = Image.blend(image, noise_layer, alpha=self.bg_alpha_noise) 

        draw = ImageDraw.Draw(image)
        nc_range = self.noise_color_range  # Localize variable for speed

        # 2. Bulk-drawn Salt-and-pepper noise (Fast C-level operation)
        num_points = rand(*self.noise_points_range)
        points = [(rand(0, w), rand(0, h)) for _ in range(num_points)]
        draw.point(points, fill=self._rand_color(nc_range))

        # 3. Background confusion arcs
        for _ in range(rand(*self.bg_arcs_range)):
            x0, y0 = rand(-20, w - 30), rand(-20, h - 30)
            x1, y1 = x0 + rand(40, 100), y0 + rand(40, 100)
            
            draw.arc(
                [x0, y0, x1, y1],
                start=rand(0, 180),
                end=rand(180, 360),
                fill=self._rand_color(nc_range),
                width=1,
            )

        # 4. Dynamic tightly-cropped character rendering
        slot_w = w // (self.length + 1)
        
        # Pre-calculate the alpha blend lookup table (LUT) for extreme speed
        if blend_factor < 1.0:
            blend_lookup_table = [int(p * blend_factor) for p in range(256)]
            
        # Unpack explicitly for speed in loop
        tr_min, tr_max, tg_min, tg_max, tb_min, tb_max = self.text_color_range
        
        for i, ch in enumerate(text):
            font = self._get_font(rand(*self.font_size_range))

            # Crop tightly to the exact character bounds to save rotation CPU cycles
            left, top, right, bottom = font.getbbox(ch)
            char_w = max(right - left, 1) + 8
            char_h = max(bottom - top, 1) + 8

            char_img = Image.new("RGBA", (char_w, char_h), (0, 0, 0, 0))
            char_draw = ImageDraw.Draw(char_img)

            char_color = (rand(tr_min, tr_max), rand(tg_min, tg_max), rand(tb_min, tb_max))
            char_draw.text((-left + 4, -top + 4), ch, font=font, fill=char_color)

            rotation_angle = rand(-self.char_rotation_limit, self.char_rotation_limit)
            rotated = char_img.rotate(rotation_angle, expand=True, resample=Image.Resampling.BILINEAR)

            # Apply Alpha Transparency Blend instantly using the LUT
            if blend_factor < 1.0:
                r_band, g_band, b_band, a_band = rotated.split()
                a_band = a_band.point(blend_lookup_table) 
                rotated = Image.merge("RGBA", (r_band, g_band, b_band, a_band))

            x = int(slot_w * (i + 0.6)) + rand(-3, 3)
            y = (h - rotated.height) // 2 + rand(-3, 3)

            image.paste(rotated, (x, max(0, y)), rotated)

        # 5. Non-linear visual wave distortion
        image = self._apply_sine_warp(image)

        # 6. Foreground strike-through lines
        # We must re-instantiate ImageDraw because the `.transform()` function creates a new Image memory reference
        draw = ImageDraw.Draw(image)
        lc_range = self.line_color_range
        
        for _ in range(rand(*self.fg_lines_range)):
            draw.line(
                (rand(0, w // 3), rand(0, h), rand(w - (w // 3), w), rand(0, h)),
                fill=self._rand_color(lc_range),
                width=1,
            )

        # 7. Final softening blur
        image = image.filter(ImageFilter.GaussianBlur(radius=self.blur_radius))

        return image, text

    def generate_base64(self, blend_factor: float = 0.5) -> tuple[str, str]:
        img, text = self.generate(blend_factor=blend_factor)

        buffer = BytesIO()
        img.save(buffer, format="PNG")

        image_b64 = b64encode(buffer.getvalue()).decode("ascii")

        return f"data:image/png;base64,{image_b64}", text


if __name__ == "__main__":
    # Example usage:
    captcha = CaptchaGenerator()
    img, answer = captcha.generate(blend_factor=0.4)
    img.save("captcha_readable.png")
    
    print(f"Generated CAPTCHA Answer: {answer}")