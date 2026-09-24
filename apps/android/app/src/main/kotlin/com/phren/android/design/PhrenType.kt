package com.phren.android.design

import androidx.compose.material3.Typography
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import com.phren.android.R

/**
 * iOS Dynamic Type at the default size (PhrenTypography.swift maps onto the
 * system text styles). SF Pro can't ship on Android, so Inter stands in for it
 * and JetBrains Mono for SF Mono, both OFL-licensed (apps/android/licenses),
 * with Apple's tracking so line lengths land where iOS puts them.
 */
object PhrenType {
    val sans = FontFamily(
        Font(R.font.inter_regular, FontWeight.Normal),
        Font(R.font.inter_medium, FontWeight.Medium),
        Font(R.font.inter_semibold, FontWeight.SemiBold),
        Font(R.font.inter_bold, FontWeight.Bold),
    )
    val mono = FontFamily(
        Font(R.font.jetbrains_mono_regular, FontWeight.Normal),
        Font(R.font.jetbrains_mono_medium, FontWeight.Medium),
        Font(R.font.jetbrains_mono_semibold, FontWeight.SemiBold),
        Font(R.font.jetbrains_mono_bold, FontWeight.Bold),
    )

    private fun style(size: Int, line: Int, tracking: Double, weight: FontWeight = FontWeight.Normal) =
        TextStyle(fontFamily = sans, fontSize = size.sp, lineHeight = line.sp, letterSpacing = (tracking * 0.9).sp, fontWeight = weight)

    val largeTitle = style(34, 41, 0.37, FontWeight.Bold)
    val title = style(28, 34, 0.36, FontWeight.Bold)
    val title2 = style(22, 28, 0.35, FontWeight.Bold)
    val title3 = style(20, 25, 0.38, FontWeight.SemiBold)
    val headline = style(17, 22, -0.43, FontWeight.SemiBold)
    val body = style(17, 22, -0.43)
    val callout = style(16, 21, -0.32)
    val subheadline = style(15, 20, -0.24)
    val footnote = style(13, 18, -0.08)
    val caption = style(12, 16, 0.0)
    val caption2 = style(11, 13, 0.07)

    fun TextStyle.mono(): TextStyle = copy(fontFamily = mono, letterSpacing = 0.sp)
    fun TextStyle.medium(): TextStyle = copy(fontWeight = FontWeight.Medium)
    fun TextStyle.semibold(): TextStyle = copy(fontWeight = FontWeight.SemiBold)
    fun TextStyle.bold(): TextStyle = copy(fontWeight = FontWeight.Bold)

    val monoBody = body.mono()
    val monoSubheadline = subheadline.mono()
    val monoFootnote = footnote.mono()
    val monoCaption = caption.mono()
    val monoCaption2 = caption2.mono()

    /** plainListSectionTypography: caption semibold, uppercase (applied by callers), 0.6 tracking. */
    val sectionLabel = caption.copy(fontWeight = FontWeight.SemiBold, letterSpacing = 0.6.sp)

    val material = Typography(
        displayLarge = largeTitle, headlineLarge = title, headlineMedium = title2, headlineSmall = title3,
        titleLarge = headline, titleMedium = headline, titleSmall = subheadline.semibold(),
        bodyLarge = body, bodyMedium = callout, bodySmall = footnote,
        labelLarge = subheadline.medium(), labelMedium = caption, labelSmall = caption2,
    )
}
