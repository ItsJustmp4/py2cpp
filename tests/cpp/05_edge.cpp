#include <iostream>
#include <string>
#include <vector>
using namespace std;

// Подсчёт гласных
int countVowels(const string& s)
{
    int count = 0;
    for (char c : s)
    {
        if (c == 'a' || c == 'e' || c == 'i' || c == 'o' || c == 'u')
            count++;
    }
    return count;
}

double average(vector<double> xs) {
    if (xs.empty()) return 0;
    double total = 0;
    for (double x : xs) total += x;
    return total / xs.size();
}

int main() {
    string line;
    getline(cin, line);
    cout << "vowels: " << countVowels(line) << endl;  // вывод
    vector<double> xs = {1.5, 2.5, 3.5};
    cout << average(xs) << endl;
    int x = 7, y = 2;
    double r = (double)x / y;
    cout << r << " " << x / y << endl;
    int total = 0;
    for (int i = 0; i < 10; i++) {
        if (i % 2) continue;
        total += i;
    }
    cout << "total=" << total << endl;
    vector<vector<int>> grid(3, vector<int>(2, 0));
    grid[0][1] = 5;
    cout << grid[0][1] << grid[1][1] << endl;
    int k = 3;
    while (k--) {
        cout << k;
    }
    cout << endl;
    string msg = x > y ? "x" : "y";
    cout << msg << '\n';
    /* блочный
       комментарий */
    bool ok = true;
    if (!ok) cout << "no";
    else cout << "yes";
    cout << endl;
    return 0;
}
